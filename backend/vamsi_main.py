from fastapi import FastAPI, UploadFile, File, Request, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, PlainTextResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import os
import uuid
import shutil
import requests
import openai
import json
from dotenv import load_dotenv
import asyncio
import aiohttp
import re
from datetime import datetime
import base64
import time

# Load environment variables
load_dotenv()

# Initialize FastAPI app
app = FastAPI()

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global variables
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
ELEVENLABS_VOICE_ID = os.getenv("ELEVEN_LABS_VOICE_ID")
ELEVENLABS_MODEL_ID = os.getenv("ELEVEN_LABS_MODEL_ID")
ELEVENLABS_OUTPUT_FORMAT = "wav"
CHATBOT_API_URL = os.getenv("CHATBOT_API_URL")
NEXT_AGI_API_KEY = os.getenv("NEXT_AGI_API_KEY")

# ElevenLabs API endpoints
ELEVENLABS_API_URL = os.getenv("ELEVENLABS_API_URL", "https://api.elevenlabs.io/v1")
TTS_ENDPOINT = f"{ELEVENLABS_API_URL}/text-to-speech/{ELEVENLABS_VOICE_ID}/stream"

# Initialize OpenAI client
client = openai.OpenAI(
    api_key=OPENAI_API_KEY,
    base_url="https://api.openai.com/v1"
)

# Global session store for WebSocket connections
sessions = {}

@app.post("/api/voice-chat")
async def voice_chat(file: UploadFile = File(...)):
    try:
        temp_path = f"/tmp/{uuid.uuid4()}.webm"
        with open(temp_path, "wb") as f:
            f.write(await file.read())
        
        try:
            with open(temp_path, "rb") as audio_file:
                transcript = client.audio.transcriptions.create(
                    model="whisper-1",
                    file=audio_file
                )
            user_text = transcript.text
        except Exception as e:
            print(f"Error in transcription: {str(e)}")
            return JSONResponse(content={"error": "Failed to transcribe audio"}, status_code=500)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

        chat_response = await get_chatbot_response(user_text)
        tts_text = strip_markdown(chat_response)

        filename = f"audio_{uuid.uuid4()}.mp3"
        file_path = f"/tmp/{filename}"
        
        try:
            headers = {
                "Accept": "audio/mpeg",
                "Content-Type": "application/json",
                "xi-api-key": ELEVENLABS_API_KEY
            }
            
            data = {
                "text": tts_text,
                "model_id": ELEVENLABS_MODEL_ID,
                "voice_settings": {
                    "stability": 0.5,
                    "similarity_boost": 0.75
                },
                "output_format": ELEVENLABS_OUTPUT_FORMAT
            }
            
            response = requests.post(
                TTS_ENDPOINT,
                json=data,
                headers=headers
            )
            
            if response.status_code == 200:
                with open(file_path, "wb") as f:
                    f.write(response.content)
                return FileResponse(
                    file_path,
                    media_type="audio/mpeg",
                    filename=filename
                )
            else:
                print(f"ElevenLabs API error: {response.text}")
                return JSONResponse(
                    content={"error": "Failed to generate audio response"},
                    status_code=500
                )
        except Exception as e:
            print(f"Error generating audio: {e}")
            return JSONResponse(
                content={"error": "Failed to generate audio response"},
                status_code=500
            )
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)

@app.websocket("/ws/audio")
async def websocket_audio(websocket: WebSocket):
    await websocket.accept()
    print("WebSocket connection accepted.")
    audio_chunks = []
    greeted = False
    session_id = str(id(websocket))
    # Start with empty conversation_id for this session
    sessions[session_id] = {
        "interrupted": False,
        "tts_task": None,
        "state": "idle",
        "start_time": datetime.now().isoformat(),
        "conversation_id": ""  # Start empty, update after first response
    }

    async def process_audio_chunks():
        if audio_chunks:
            print(f"[TIMEOUT] Processing {len(audio_chunks)} audio chunks due to silence timeout...")
            try:
                print("[Backend] Starting transcription...")
                audio_bytes = b"".join(audio_chunks)
                print(f"[Backend] Total audio size: {len(audio_bytes)} bytes")
                
                if len(audio_bytes) == 0:
                    print("[Backend] Warning: No audio data to process")
                    return
                    
                transcript = await transcribe_with_whisper(audio_bytes)
                if not transcript:
                    print("[Backend] Warning: Empty transcript received")
                    return
                    
                print(f"[Backend] Transcription complete: {transcript}")
                await safe_send_json(websocket, {"type": "transcript", "text": transcript})
                
                print("[Backend] Getting chatbot response...")
                response, new_conversation_id = await get_chatbot_response(
                    transcript,
                    {"conversation_id": sessions[session_id]["conversation_id"]},
                    websocket
                )
                
                if not response:
                    print("[Backend] Warning: No response from chatbot")
                    return
                    
                print(f"[Backend] Chatbot response: {response}")
                
                if new_conversation_id and not sessions[session_id]["conversation_id"]:
                    sessions[session_id]["conversation_id"] = new_conversation_id
                    
                print("[Backend] Finished streaming TTS chunks.")
                sessions[session_id]["state"] = "idle"
                await safe_send_json(websocket, {"type": "agent_idle"})
                await safe_send_json(websocket, {"type": "user_speaking"})
            except Exception as e:
                print(f"[Backend] Error processing audio chunks (timeout): {str(e)}")
                await safe_send_json(websocket, {"type": "error", "message": "Failed to process audio"})
            finally:
                audio_chunks.clear()

    silence_timeout = 2.0  # seconds
    last_audio_time = None
    timeout_task = None

    try:
        while True:
            if websocket.client_state.name != "CONNECTED":
                print("WebSocket no longer connected, breaking loop.")
                break
            try:
                data = await asyncio.wait_for(websocket.receive(), timeout=silence_timeout)
                if "text" in data:
                    print(f"[Backend] Received TEXT message: {data['text']}")
                    try:
                        msg = json.loads(data["text"])
                        print(f"Parsed JSON message: {msg}")
                        if msg.get("type") == "cleanup":
                            await cleanup_session(session_id)
                            break
                        if msg.get("type") == "start" and not greeted:
                            greeted = True
                            greeting = msg.get("message") or "Hi, this is your agent. How can I help you today?"
                            print(f"Sending greeting: {greeting}")
                            await safe_send_json(websocket, {"type": "greeting", "text": greeting})
                            print("Starting to stream greeting audio...")
                            try:
                                await stream_elevenlabs_tts(greeting, websocket)
                            except Exception as e:
                                print(f"Error streaming greeting audio: {e}")
                                raise
                            print("Sending greeting_end message")
                            await safe_send_json(websocket, {"type": "greeting_end"})
                            await safe_send_json(websocket, {"type": "user_speaking"})
                            continue
                        if msg.get("type") == "done":
                            print("Received 'done' message from client.")
                            print(f"Total audio chunks received: {len(audio_chunks)}")
                            if sessions[session_id]["state"] == "agent_speaking":
                                sessions[session_id]["interrupted"] = True
                                tts_task = sessions[session_id].get("tts_task")
                                if tts_task and not tts_task.done():
                                    tts_task.cancel()
                                await safe_send_json(websocket, {"type": "interrupted"})
                                await safe_send_json(websocket, {"type": "agent_idle"})
                            if audio_chunks:
                                print(f"Received {len(audio_chunks)} audio chunks. Processing...")
                                await process_audio_chunks()
                            continue
                    except json.JSONDecodeError as e:
                        print(f"Error parsing JSON message: {e}")
                        continue
                    except Exception as e:
                        print(f"Error processing text message: {e}")
                    continue
                if "bytes" in data:
                    print(f"[Backend] Received BINARY audio chunk of size: {len(data['bytes'])}")
                    audio_chunks.append(data["bytes"])
                    last_audio_time = datetime.now()
            except asyncio.TimeoutError:
                print("[Backend] Silence timeout reached, processing audio chunks...")
                await process_audio_chunks()
                last_audio_time = None
    except Exception as e:
        print(f"Fatal WebSocket error: {e}")
    finally:
        if session_id in sessions:
            del sessions[session_id]

async def safe_send_json(websocket, data):
    try:
        print(f"Sending JSON: {data}")
        await websocket.send_json(data)
    except WebSocketDisconnect:
        print("Client disconnected while sending JSON")
        raise
    except Exception as e:
        print(f"Error sending JSON: {e}")
        raise

async def safe_send_bytes(websocket, data):
    try:
        print(f"Sending bytes of size: {len(data)}")
        await websocket.send_bytes(data)
    except WebSocketDisconnect:
        print("Client disconnected while sending bytes")
        raise
    except Exception as e:
        print(f"Error sending bytes: {e}")
        raise

async def transcribe_with_whisper(audio_bytes):
    temp_path = f"/tmp/{uuid.uuid4()}.webm"
    try:
        # Ensure the /tmp directory exists
        os.makedirs("/tmp", exist_ok=True)
        
        # Write the audio bytes to the temporary file
        with open(temp_path, "wb") as f:
            f.write(audio_bytes)
        
        # Verify the file exists and has content
        if not os.path.exists(temp_path):
            raise Exception("Failed to create temporary audio file")
        
        # Get file size
        file_size = os.path.getsize(temp_path)
        if file_size == 0:
            raise Exception("Temporary audio file is empty")
            
        print(f"Processing audio file: {temp_path} (size: {file_size} bytes)")
        
        # Process the audio file
        with open(temp_path, "rb") as audio_file:
            transcript = client.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file
            )
        return transcript.text
    except Exception as e:
        print(f"Error in transcription: {str(e)}")
        raise
    finally:
        # Clean up the temporary file
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
                print(f"Cleaned up temporary file: {temp_path}")
        except Exception as e:
            print(f"Error cleaning up temporary file: {e}")

async def get_chatbot_response(user_text, conversation_state=None, websocket=None):
    # Always use the provided conversation_id (do not update from chatbot response except for first response)
    if conversation_state and "conversation_id" in conversation_state:
        conversationid = conversation_state["conversation_id"]
    else:
        conversationid = ""

    url = "https://rnd.xpectrum-ai.com/v1/chat-messages"
    headers = {
        "Authorization": "Bearer app-qM6HvFLJXQxMcq1ymvYJBVAE",
        "Content-Type": "application/json"
    }
    payload = {
        "inputs": {},
        "query": user_text,
        "response_mode": "streaming",
        "conversation_id": conversationid,
        "user": "abc-123",
        "files": [
            {
                "type": "image",
                "transfer_method": "remote_url",
                "url": ""
            }
        ]
    }
    print("payload",payload)
    try:
        print("Sending request to chatbot API...")
        response = requests.post(url, headers=headers, json=payload, stream=True)
        print("##########################################",response.text)
        if response.status_code != 200:
            print(f"Error: Received status code {response.status_code}")
            print("Response body:", response.text)
            return None, None
        print("Response from chatbot (streaming):")
        current_sentence = ""
        full_response = ""
        sentence_endings = ['.', '!', '?']
        new_conversation_id = None
        for line in response.iter_lines(decode_unicode=True):
            if line and line.startswith('data: '):
                try:
                    data = json.loads(line[6:])
                    # Extract conversation_id from first response if present
                    if "conversation_id" in data and not conversationid:
                        new_conversation_id = data["conversation_id"]
                    if 'answer' in data:
                        word = data['answer']
                        print(word, end="", flush=True)
                        full_response += word
                        current_sentence += word
                        # Check if we have a complete sentence (ends with . ! ?)
                        if any(current_sentence.strip().endswith(p) for p in sentence_endings):
                            if websocket and current_sentence.strip():
                                # Send the sentence to frontend for display
                                await safe_send_json(websocket, {"type": "response", "text": current_sentence})
                                # Stream the sentence to TTS
                                tts_text = strip_markdown(current_sentence)
                                await stream_elevenlabs_tts(tts_text, websocket)
                                # Reset current sentence
                                current_sentence = ""
                except json.JSONDecodeError:
                    continue
        # Handle any remaining text (if not ended with punctuation)
        if current_sentence.strip() and websocket:
            await safe_send_json(websocket, {"type": "response", "text": current_sentence})
            tts_text = strip_markdown(current_sentence)
            await stream_elevenlabs_tts(tts_text, websocket)
        return full_response, new_conversation_id
    except Exception as e:
        print(f"An error occurred: {e}")
        raise

async def stream_elevenlabs_tts(text, websocket):
    try:
        headers = {
            "Accept": "audio/wav",
            "Content-Type": "application/json",
            "xi-api-key": ELEVENLABS_API_KEY or "sk_36686ad9136dcfccb467f2198754e0e513a57b922132c55e"
        }
        data = {
            "text": text,
            "model_id": ELEVENLABS_MODEL_ID,
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.75
            },
            "output_format": "wav"
        }
        audio_data = bytearray()
        async with aiohttp.ClientSession() as session:
            async with session.post(TTS_ENDPOINT, json=data, headers=headers) as response:
                if response.status == 200:
                    async for chunk in response.content.iter_chunked(16384):
                        if chunk:
                            audio_data.extend(chunk)
                else:
                    error_text = await response.text()
                    print(f"ElevenLabs API error: {error_text}")
                    raise Exception(f"ElevenLabs API error: {response.status}")

        # After all chunks are received, send the full audio_data to the frontend
        await safe_send_bytes(websocket, bytes(audio_data))
    except Exception as e:
        print(f"Error in TTS generation: {e}")
        raise

def strip_markdown(text):
    # Remove bold and italic
    text = re.sub(r'\*\*(.*?)\*\*', r'\1', text)
    text = re.sub(r'\*(.*?)\*', r'\1', text)
    # Remove other markdown symbols (optional)
    text = re.sub(r'`', '', text)
    text = re.sub(r'#+ ', '', text)
    text = re.sub(r'- ', '', text)
    return text

def split_into_chunks(text, max_words=20):
    words = text.split()
    chunks = []
    for i in range(0, len(words), max_words):
        chunk = ' '.join(words[i:i+max_words])
        chunks.append(chunk)
    return chunks

# Helper coroutine for streaming TTS with interruption checks
async def stream_and_send_tts_chunks(websocket, session_id, tts_chunks):
    for i, chunk in enumerate(tts_chunks):
        if sessions[session_id]["interrupted"]:
            print("TTS streaming interrupted by user.")
            # Notify frontend agent is idle if interrupted
            await safe_send_json(websocket, {"type": "agent_idle"})
            break
        await stream_elevenlabs_tts(chunk, websocket)
        await safe_send_json(websocket, {"end": True})
        print("Sent {end: true} for chunk", i+1)

async def cleanup_session(session_id):
    """Clean up session resources."""
    try:
        # Cancel any ongoing TTS task
        if sessions[session_id]["tts_task"] and not sessions[session_id]["tts_task"].done():
            sessions[session_id]["tts_task"].cancel()
            try:
                await sessions[session_id]["tts_task"]
            except asyncio.CancelledError:
                pass

        # Remove session
        if session_id in sessions:
            del sessions[session_id]
            print(f"Session {session_id} cleaned up successfully")
    except Exception as e:
        print(f"Error during session cleanup: {e}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
