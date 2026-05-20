import { useState, useEffect, useRef } from "react";
import {
  getDatabase, ref, push, onValue, off, query,
  orderByChild, limitToLast,
} from "firebase/database";
import { getApp } from "firebase/app";
import { FONT, T } from "./tokens";

interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  ts: number;
}

function relTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5)  return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export function Chat({
  gameCode,
  playerId,
  playerName,
  open,
  onClose,
  onUnread,
  side = "left",
}: {
  gameCode: string;
  playerId: string;
  playerName: string;
  open: boolean;
  onClose: () => void;
  onUnread?: (n: number) => void;
  side?: "left" | "right";
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft,    setDraft]    = useState("");
  const bottomRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(open);

  function getDb()      { return getDatabase(getApp()); }
  function getChatRef() { return ref(getDb(), `chats/${gameCode}`); }

  useEffect(() => {
    if (!gameCode) return;
    const q = query(getChatRef(), orderByChild("ts"), limitToLast(120));
    const unsub = onValue(q, (snap) => {
      const msgs: ChatMessage[] = [];
      snap.forEach((child) => { msgs.push({ id: child.key!, ...child.val() }); });
      setMessages(msgs);
      if (!wasOpenRef.current) onUnread?.(1);
    });
    return () => off(q, "value", unsub);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameCode]);

  useEffect(() => {
    wasOpenRef.current = open;
    if (open) setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      inputRef.current?.focus();
    }, 60);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  async function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await push(getChatRef(), { senderId: playerId, senderName: playerName, text, ts: Date.now() });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  if (!open) return null;

  return (
    <>
      {/* Chat card — dark inverted from the spec */}
      <div style={{
        position: "fixed",
        bottom: 88,
        [side === "right" ? "right" : "left"]: 20,
        width: 280,
        zIndex: 201,
        backgroundColor: "#111",
        border: "1px solid #333",
        borderRadius: 5,
        boxShadow: "2px 2px 5px rgba(0,0,0,0.6)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          backgroundColor: "#f0f0f0",
          color: "#111",
          padding: "10px 12px",
          fontSize: 16,
          fontWeight: 700,
          fontFamily: FONT,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTopLeftRadius: 5,
          borderTopRightRadius: 5,
        }}>
          <span>💬 Room Chat</span>
          <button onClick={onClose} style={{
            background: "none", border: "none", cursor: "pointer",
            color: "#333", fontSize: 16, lineHeight: 1, padding: "0 4px",
            fontFamily: FONT,
          }}>✕</button>
        </div>

        {/* Message window */}
        <div style={{
          height: 220,
          overflowY: "scroll",
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          listStyle: "none",
        }}>
          {messages.length === 0 && (
            <div style={{
              textAlign: "center", color: "#666",
              fontSize: 12, fontFamily: FONT, marginTop: 32,
            }}>
              No messages yet. Say something!
            </div>
          )}

          {messages.map((msg) => {
            const isMe = msg.senderId === playerId;
            return (
              <div key={msg.id} style={{
                display: "flex",
                flexDirection: isMe ? "row-reverse" : "row",
                alignItems: "flex-end",
                gap: 6,
              }}>
                {!isMe && (
                  <div style={{
                    width: 24, height: 24, borderRadius: "50%", flexShrink: 0,
                    background: "#333",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 10, fontWeight: 700, color: "#eee", fontFamily: FONT,
                  }}>
                    {msg.senderName[0].toUpperCase()}
                  </div>
                )}
                <div style={{ maxWidth: "72%", display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start", gap: 2 }}>
                  {!isMe && (
                    <span style={{ fontSize: 10, color: "#888", fontFamily: FONT }}>
                      {msg.senderName}
                    </span>
                  )}
                  <div style={{
                    padding: "6px 10px",
                    borderRadius: isMe ? "10px 10px 2px 10px" : "10px 10px 10px 2px",
                    background: isMe ? "#333" : "#222",
                    border: `1px solid ${isMe ? "#555" : "#3a3a3a"}`,
                    color: "#f0f0f0",
                    fontSize: 13, fontFamily: FONT, lineHeight: 1.5,
                    wordBreak: "break-word",
                  }}>
                    {msg.text}
                  </div>
                  <span style={{ fontSize: 10, color: "#555", fontFamily: FONT }}>
                    {relTime(msg.ts)}
                  </span>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Input row */}
        <div style={{
          display: "flex",
          alignItems: "center",
          padding: 10,
          borderTop: "1px solid #333",
        }}>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message..."
            maxLength={300}
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              padding: 5,
              fontSize: 13,
              color: "#f0f0f0",
              fontFamily: FONT,
            }}
          />
          <button
            onClick={send}
            disabled={!draft.trim()}
            className="send-button"
            style={{
              border: "none",
              outline: "none",
              backgroundColor: "#333",
              color: "#fff",
              fontSize: 13,
              padding: "5px 10px",
              cursor: draft.trim() ? "pointer" : "not-allowed",
              fontFamily: FONT,
              opacity: draft.trim() ? 1 : 0.4,
              borderRadius: 4,
              flexShrink: 0,
            }}
          >
            Send
          </button>
        </div>
      </div>
    </>
  );
}

export function UnreadBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div style={{
      position: "absolute", top: -6, right: -6,
      width: 18, height: 18, borderRadius: "50%",
      background: T.red, color: "#fff",
      fontSize: 10, fontWeight: 700, fontFamily: FONT,
      display: "flex", alignItems: "center", justifyContent: "center",
      border: "2px solid #000",
    }}>
      {count > 9 ? "9+" : count}
    </div>
  );
}
