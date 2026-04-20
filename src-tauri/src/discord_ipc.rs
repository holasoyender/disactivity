use serde_json::json;
use std::io::{Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::fs::OpenOptions;

/// Discord IPC opcodes
const OP_HANDSHAKE: u32 = 0;
const OP_FRAME: u32 = 1;
const OP_CLOSE: u32 = 2;

/// A connection to Discord's local IPC socket (named pipe on Windows).
/// Used for setting Rich Presence / activity via RPC.
pub struct DiscordIpcConnection {
    #[cfg(windows)]
    pipe: std::fs::File,
    pub client_id: String,
}

impl DiscordIpcConnection {
    /// Connect to Discord's IPC pipe and perform the handshake.
    /// `client_id` should be the Discord Application ID (game.id from the API).
    pub fn connect(client_id: &str) -> Result<Self, String> {
        let pipe = Self::open_pipe()?;
        let mut conn = DiscordIpcConnection {
            pipe,
            client_id: client_id.to_string(),
        };
        conn.handshake()?;
        Ok(conn)
    }

    /// Try to open one of Discord's IPC pipes (discord-ipc-0 through discord-ipc-9)
    #[cfg(windows)]
    fn open_pipe() -> Result<std::fs::File, String> {
        for i in 0..10 {
            let pipe_name = format!(r"\\.\pipe\discord-ipc-{}", i);
            match OpenOptions::new()
                .read(true)
                .write(true)
                .open(&pipe_name)
            {
                Ok(file) => return Ok(file),
                Err(_) => continue,
            }
        }
        Err("Could not connect to Discord. Make sure Discord is running.".to_string())
    }

    /// Send the handshake message (opcode 0) with the client_id
    fn handshake(&mut self) -> Result<(), String> {
        let payload = json!({
            "v": 1,
            "client_id": self.client_id,
        });
        self.send(OP_HANDSHAKE, &payload)?;
        // Read the READY response
        let (_op, response) = self.recv()?;
        // Check for errors in the response
        if let Some(evt) = response.get("evt").and_then(|v| v.as_str()) {
            if evt == "ERROR" {
                let msg = response
                    .get("data")
                    .and_then(|d| d.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error during handshake");
                return Err(format!("Discord IPC error: {}", msg));
            }
        }
        Ok(())
    }

    /// Set the user's activity (Rich Presence).
    /// This makes Discord show "Playing [Game Name]".
    pub fn set_activity(&mut self) -> Result<(), String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs();

        let nonce = format!("{}", now);

        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "args": {
                "pid": std::process::id(),
                "activity": {
                    "timestamps": {
                        "start": now
                    }
                }
            },
            "nonce": nonce,
        });

        self.send(OP_FRAME, &payload)?;
        // Read the response
        let (_op, _response) = self.recv()?;
        Ok(())
    }

    /// Clear the user's activity
    pub fn clear_activity(&mut self) -> Result<(), String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs();

        let nonce = format!("clear-{}", now);

        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "args": {
                "pid": std::process::id(),
            },
            "nonce": nonce,
        });

        self.send(OP_FRAME, &payload)?;
        // Try to read response, but don't error if pipe is closing
        let _ = self.recv();
        Ok(())
    }

    /// Close the IPC connection gracefully
    pub fn close(&mut self) {
        let payload = json!({});
        let _ = self.send(OP_CLOSE, &payload);
    }

    /// Send a framed message: 4 bytes opcode (LE) + 4 bytes length (LE) + JSON payload
    fn send(&mut self, opcode: u32, payload: &serde_json::Value) -> Result<(), String> {
        let payload_str = payload.to_string();
        let payload_bytes = payload_str.as_bytes();
        let len = payload_bytes.len() as u32;

        let mut buf = Vec::with_capacity(8 + payload_bytes.len());
        buf.extend_from_slice(&opcode.to_le_bytes());
        buf.extend_from_slice(&len.to_le_bytes());
        buf.extend_from_slice(payload_bytes);

        self.pipe
            .write_all(&buf)
            .map_err(|e| format!("Failed to write to Discord IPC: {}", e))?;
        self.pipe
            .flush()
            .map_err(|e| format!("Failed to flush Discord IPC: {}", e))?;

        Ok(())
    }

    /// Receive a framed message from Discord
    fn recv(&mut self) -> Result<(u32, serde_json::Value), String> {
        // Read header: 4 bytes opcode + 4 bytes length
        let mut header = [0u8; 8];
        self.pipe
            .read_exact(&mut header)
            .map_err(|e| format!("Failed to read from Discord IPC: {}", e))?;

        let opcode = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
        let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);

        // Read payload
        let mut payload_buf = vec![0u8; length as usize];
        self.pipe
            .read_exact(&mut payload_buf)
            .map_err(|e| format!("Failed to read payload from Discord IPC: {}", e))?;

        let payload: serde_json::Value = serde_json::from_slice(&payload_buf)
            .map_err(|e| format!("Failed to parse Discord IPC response: {}", e))?;

        Ok((opcode, payload))
    }
}

impl Drop for DiscordIpcConnection {
    fn drop(&mut self) {
        self.close();
    }
}



