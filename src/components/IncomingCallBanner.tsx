import { Phone, PhoneOff, Video } from 'lucide-react';
import { api } from '../lib/api';
import { activeCallStore, incomingCallStore, useIncomingCall } from '../lib/store';
import type { ActiveCall } from '../lib/types';
import { Avatar } from './ui';
import { toastError } from './Toast';

export function IncomingCallBanner() {
  const incoming = useIncomingCall();

  if (!incoming) return null;

  const joinCall = async () => {
    try {
      const res = await api<ActiveCall>(`/conversations/${incoming.conversationId}/call/token`, {
        method: 'POST',
        body: { isVideo: incoming.isVideo },
      });
      incomingCallStore.set(null);
      activeCallStore.set({
        ...res,
        conversationId: incoming.conversationId,
        isVideo: incoming.isVideo,
      });
    } catch (err) {
      toastError(err);
    }
  };

  const declineCall = () => {
    api(`/conversations/${incoming.conversationId}/call/leave`, { method: 'POST' }).catch(() => {});
    incomingCallStore.set(null);
  };

  return (
    <div className="incoming-call-overlay">
      <div className="incoming-call-card">
        <div className="incoming-call-avatar-pulse">
          <Avatar user={{ id: incoming.caller.id, name: incoming.caller.name, avatar: incoming.caller.avatar }} size={56} />
          <span className="pulse-ring" />
        </div>
        <div className="incoming-call-info">
          <div className="incoming-call-title">
            {incoming.isVideo ? <Video size={16} className="call-icon" /> : <Phone size={16} className="call-icon" />}
            <strong>Incoming {incoming.isVideo ? 'Video' : 'Audio'} Call</strong>
          </div>
          <div className="incoming-call-caller">{incoming.caller.name}</div>
          <div className="incoming-call-conv truncate">{incoming.conversationTitle}</div>
        </div>
        <div className="incoming-call-actions">
          <button className="call-action-btn decline" onClick={declineCall} title="Decline">
            <PhoneOff size={20} />
          </button>
          <button className="call-action-btn accept" onClick={joinCall} title="Accept">
            <Phone size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
