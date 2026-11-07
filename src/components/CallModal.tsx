import { useState } from 'react';
import { LiveKitRoom, VideoConference } from '@livekit/components-react';
import '@livekit/components-styles';
import { Maximize2, Minimize2, PhoneOff } from 'lucide-react';
import { api } from '../lib/api';
import { activeCallStore, useActiveCall } from '../lib/store';

export function CallModal() {
  const activeCall = useActiveCall();
  const [minimized, setMinimized] = useState(false);

  if (!activeCall) return null;

  const handleLeave = () => {
    api(`/conversations/${activeCall.conversationId}/call/leave`, { method: 'POST' }).catch(() => {});
    activeCallStore.set(null);
    setMinimized(false);
  };

  if (minimized) {
    return (
      <div className="floating-call-pill">
        <span className="live-dot" />
        <span className="pill-text">Call in progress</span>
        <button className="icon-btn-pill" onClick={() => setMinimized(false)} title="Maximize">
          <Maximize2 size={16} />
        </button>
        <button className="icon-btn-pill danger" onClick={handleLeave} title="End call">
          <PhoneOff size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="call-modal-overlay">
      <div className="call-modal-container">
        <div className="call-modal-header">
          <div className="call-header-info">
            <span className="live-badge">LIVE</span>
            <span className="call-room-title">{activeCall.isVideo ? 'Video Conference' : 'Voice Conference'}</span>
          </div>
          <div className="call-header-actions">
            <button className="call-header-btn" onClick={() => setMinimized(true)} title="Minimize call">
              <Minimize2 size={18} />
            </button>
            <button className="call-header-btn danger" onClick={handleLeave} title="Leave call">
              <PhoneOff size={18} />
            </button>
          </div>
        </div>

        <div className="call-modal-body">
          <LiveKitRoom
            serverUrl={activeCall.serverUrl}
            token={activeCall.token}
            connect={true}
            video={activeCall.isVideo}
            audio={true}
            onDisconnected={handleLeave}
            data-lk-theme="default"
            className="lk-room-container"
          >
            <VideoConference />
          </LiveKitRoom>
        </div>
      </div>
    </div>
  );
}
