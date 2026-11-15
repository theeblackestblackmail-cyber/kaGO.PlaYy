import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowBigUp,
  ArrowLeft,
  MessageSquare,
  Play,
  Plus,
  Radio,
  Send,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type { StudioRoomState, Track } from '../types/audio';
import { triggerHaptic } from '../utils/haptics';
import { formatDuration } from '../utils/lrcParser';

interface SharedLiveStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
  availableTracks: Track[];
  onPlayTrack: (track: Track) => void;
}

export const SharedLiveStudioModal: React.FC<SharedLiveStudioModalProps> = ({
  isOpen,
  onClose,
  availableTracks,
  onPlayTrack,
}) => {
  const [roomState, setRoomState] = useState<StudioRoomState>({
    userCount: 1,
    users: [],
    queue: [],
    nowPlaying: null,
    messages: [],
  });
  const [clientId, setClientId] = useState<string>('');
  const [userName, setUserName] = useState<string>('Studio Listener');
  const [connected, setConnected] = useState(false);
  const [selectedAddTrackId, setSelectedAddTrackId] = useState<string>(
    availableTracks[0]?.id || ''
  );
  const [chatInput, setChatInput] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!selectedAddTrackId && availableTracks.length > 0) {
      setSelectedAddTrackId(availableTracks[0].id);
    }
  }, [availableTracks, selectedAddTrackId]);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/studio`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!cancelled) setConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string) as {
            type: string;
            clientId?: string;
            userName?: string;
            state?: StudioRoomState;
            userCount?: number;
            users?: StudioRoomState['users'];
            queue?: StudioRoomState['queue'];
            nowPlaying?: StudioRoomState['nowPlaying'];
            message?: StudioRoomState['messages'][number];
          };

          if (data.type === 'studio:init' && data.state) {
            setClientId(data.clientId || '');
            if (data.userName) setUserName(data.userName);
            setRoomState(data.state);
          } else if (data.type === 'studio:presence') {
            setRoomState((prev) => ({
              ...prev,
              userCount: data.userCount ?? prev.userCount,
              users: data.users ?? prev.users,
            }));
          } else if (data.type === 'studio:queue_updated' && data.queue) {
            setRoomState((prev) => ({ ...prev, queue: data.queue! }));
          } else if (data.type === 'studio:playback_updated') {
            setRoomState((prev) => ({ ...prev, nowPlaying: data.nowPlaying ?? null }));
          } else if (data.type === 'studio:chat_message' && data.message) {
            setRoomState((prev) => {
              if (prev.messages.some((m) => m.id === data.message!.id)) return prev;
              return { ...prev, messages: [...prev.messages, data.message!] };
            });
          }
        } catch {
          // Ignore invalid socket frames
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) {
          reconnectTimer = window.setTimeout(connect, 2000);
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [isOpen]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [roomState.messages.length]);

  if (!isOpen) return null;

  const sendSocket = (payload: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  };

  const handleUpdateName = (e: React.FormEvent) => {
    e.preventDefault();
    triggerHaptic('light');
    sendSocket({ type: 'studio:join', name: userName });
  };

  const handleAddTrack = () => {
    const track = availableTracks.find((t) => t.id === selectedAddTrackId);
    if (!track) return;
    triggerHaptic('selection');
    sendSocket({ type: 'studio:add_track', track });
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    triggerHaptic('light');
    sendSocket({ type: 'studio:chat', text: chatInput });
    setChatInput('');
  };

  return (
    <div
      className="kago-modal-backdrop fixed inset-0 z-[70] flex flex-col sm:items-center sm:justify-center bg-black/90 backdrop-blur-sm sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shared-studio-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          triggerHaptic('light');
          onClose();
        }
      }}
    >
      <div className="kago-sheet-slide flex h-[100dvh] w-full flex-col bg-[#0D0E12] sm:h-auto sm:max-h-[90dvh] sm:max-w-5xl sm:rounded-xl sm:border sm:border-[#242732] overflow-hidden">
        {/* Modal Header */}
        <div className="shrink-0 flex flex-wrap items-center justify-between gap-2.5 border-b border-[#1E2028] bg-[#090A0E] px-3.5 py-3 sm:px-5 sm:py-4 pt-[max(0.75rem,env(safe-area-inset-top))] sm:pt-4">
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onClose();
              }}
              aria-label="Back from Shared Live Studio"
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-[#262936] bg-[#14161D] px-3 text-xs font-semibold text-[#F4F3F0] hover:border-[#E11D48] hover:text-white transition-colors cursor-pointer"
            >
              <ArrowLeft className="h-4 w-4 text-[#E11D48]" />
              <span>Back</span>
            </button>
            <div className="hidden min-[420px]:flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#E11D48]/40 bg-[#E11D48]/15 text-[#FF4D6D]">
              <Radio className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2
                id="shared-studio-title"
                className="truncate font-display text-base sm:text-lg font-bold text-[#F4F3F0]"
              >
                Shared Live Studio
              </h2>
              <div className="flex items-center gap-2 text-xs text-[#8E929B]">
                <span className="inline-flex items-center gap-1.5 font-mono-tabular text-[#FF4D6D]">
                  <Users className="h-3.5 w-3.5" />
                  <span>
                    {roomState.userCount} live{' '}
                    {roomState.userCount === 1 ? 'listener' : 'listeners'}
                  </span>
                </span>
                <span className="hidden sm:inline" aria-hidden="true">·</span>
                <span className="hidden sm:inline">{connected ? 'WebSocket Synced' : 'Connecting...'}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <form onSubmit={handleUpdateName} className="hidden md:flex items-center gap-1.5">
              <input
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                aria-label="Your studio display name"
                className="w-36 rounded-lg border border-[#262936] bg-[#121319] px-2.5 py-1.5 text-xs text-[#F4F3F0] focus:border-[#E11D48] focus:outline-none"
              />
              <button
                type="submit"
                className="rounded-lg border border-[#262936] bg-[#161820] px-2.5 py-1.5 text-xs font-medium text-[#D1D5DB] hover:border-[#E11D48] cursor-pointer"
              >
                Set Name
              </button>
            </form>
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onClose();
              }}
              aria-label="Close Shared Live Studio"
              className="hidden sm:flex h-9 w-9 items-center justify-center rounded-lg border border-[#262936] bg-[#14161D] text-[#8E929B] hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body Split: Shared Queue (Left) + Live Chat Sidebar (Right) */}
        <div className="grid flex-1 grid-cols-1 lg:grid-cols-12 overflow-hidden">
          {/* Shared Queue & Playback */}
          <div className="lg:col-span-7 flex flex-col border-b lg:border-b-0 lg:border-r border-[#1E2028] p-4 sm:p-5 overflow-y-auto">
            {roomState.nowPlaying && (
              <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-[#E11D48]/50 bg-[#17090E] p-3">
                <div className="min-w-0">
                  <div className="font-mono-tabular text-[11px] font-semibold text-[#FF4D6D]">
                    ON AIR · TRIGGERED BY {roomState.nowPlaying.triggeredBy}
                  </div>
                  <div className="truncate text-sm font-bold text-[#F4F3F0]">
                    {roomState.nowPlaying.track.title} — {roomState.nowPlaying.track.artist}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('selection');
                    onPlayTrack(roomState.nowPlaying!.track);
                  }}
                  className="shrink-0 rounded-lg bg-[#E11D48] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#BE123C] cursor-pointer"
                >
                  Listen Sync
                </button>
              </div>
            )}

            {/* Add Track Bar */}
            <div className="flex flex-col sm:flex-row gap-2">
              <select
                value={selectedAddTrackId}
                onChange={(e) => setSelectedAddTrackId(e.target.value)}
                aria-label="Select track to add to shared studio queue"
                className="flex-1 rounded-lg border border-[#262936] bg-[#08090C] px-3 py-2 text-xs text-[#F4F3F0] focus:border-[#E11D48] focus:outline-none"
              >
                {availableTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title} — {t.artist}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleAddTrack}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] whitespace-nowrap cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add to Shared Queue</span>
              </button>
            </div>

            {/* Upvote Queue List */}
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between text-xs text-[#8E929B]">
                <span>Shared Upvote Queue</span>
                <span className="font-mono-tabular">{roomState.queue.length} queued</span>
              </div>

              {roomState.queue.map((item) => {
                const hasVoted = item.voterIds.includes(clientId);
                return (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-[#1E2028] bg-[#121319] px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[#F4F3F0]">
                        {item.track.title}
                      </p>
                      <p className="truncate text-xs text-[#8E929B]">
                        {item.track.artist} · Added by {item.addedBy} ·{' '}
                        <span className="font-mono-tabular">{formatDuration(item.track.duration)}</span>
                      </p>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('selection');
                          sendSocket({ type: 'studio:toggle_upvote', itemId: item.id });
                        }}
                        aria-label={`Upvote ${item.track.title}`}
                        className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 font-mono-tabular text-xs font-semibold transition-colors cursor-pointer ${
                          hasVoted
                            ? 'border-[#E11D48] bg-[#E11D48]/20 text-[#FF4D6D]'
                            : 'border-[#2A2D39] bg-[#161820] text-[#D1D5DB] hover:border-[#E11D48]'
                        }`}
                      >
                        <ArrowBigUp className={`h-4 w-4 ${hasVoted ? 'fill-current' : ''}`} />
                        <span>{item.upvotes}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('selection');
                          sendSocket({ type: 'studio:play_track', track: item.track });
                          onPlayTrack(item.track);
                        }}
                        aria-label={`Play ${item.track.title} in studio`}
                        className="flex h-8 w-8 items-center justify-center rounded-md bg-[#E11D48] text-white hover:bg-[#BE123C] cursor-pointer"
                      >
                        <Play className="h-3.5 w-3.5 fill-current" />
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          sendSocket({ type: 'studio:remove_track', itemId: item.id });
                        }}
                        aria-label={`Remove ${item.track.title} from shared queue`}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-[#8E929B] hover:text-[#FF4D6D] cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Live Studio Chat Sidebar */}
          <div className="lg:col-span-5 flex flex-col bg-[#08090D] h-[340px] lg:h-auto">
            <div className="flex items-center gap-2 border-b border-[#1E2028] px-4 py-3 text-xs font-semibold text-[#C7C9D1]">
              <MessageSquare className="h-4 w-4 text-[#E11D48]" />
              <span>Live Studio Chat</span>
            </div>

            <div className="flex-1 space-y-2.5 overflow-y-auto p-4">
              {roomState.messages.map((msg) => (
                <div
                  key={msg.id}
                  className={
                    msg.type === 'system'
                      ? 'rounded border border-[#222530] bg-[#101218] px-2.5 py-1.5 text-xs text-[#8E929B]'
                      : 'rounded-lg border border-[#1E2028] bg-[#12141B] px-3 py-2'
                  }
                >
                  {msg.type !== 'system' && (
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="font-semibold text-[#FF4D6D]">{msg.userName}</span>
                      <span className="font-mono-tabular text-[#6B7280]">
                        {new Date(msg.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  )}
                  <p className={msg.type === 'system' ? '' : 'mt-1 text-xs text-[#F4F3F0]'}>
                    {msg.text}
                  </p>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            <form
              onSubmit={handleSendChat}
              className="flex items-center gap-2 border-t border-[#1E2028] p-3"
            >
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Message live listeners..."
                aria-label="Send message to studio chat"
                className="flex-1 rounded-lg border border-[#262936] bg-[#111319] px-3 py-2 text-xs text-[#F4F3F0] placeholder-[#6B7280] focus:border-[#E11D48] focus:outline-none"
              />
              <button
                type="submit"
                aria-label="Send chat message"
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#E11D48] text-white hover:bg-[#BE123C] cursor-pointer"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};
