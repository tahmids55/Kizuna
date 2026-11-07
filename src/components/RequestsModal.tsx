import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Clock, UserCheck, UserX, X } from 'lucide-react';
import { api } from '../lib/api';
import { listTime } from '../lib/format';
import { queryClient, upsertConversation, useRequests } from '../lib/store';
import type { Conversation, MessageRequest } from '../lib/types';
import { Avatar, Modal, Segmented, Spinner } from './ui';
import { toast, toastError } from './Toast';

export function RequestsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { data, isLoading } = useRequests();
  const [tab, setTab] = useState<'incoming' | 'outgoing'>('incoming');
  const [actingId, setActingId] = useState<number | null>(null);

  const incoming = data?.incoming ?? [];
  const outgoing = data?.outgoing ?? [];
  const pendingIncoming = incoming.filter((r) => r.status === 'pending');

  const accept = async (r: MessageRequest) => {
    setActingId(r.id);
    try {
      const res = await api<{ request: MessageRequest; conversation: Conversation }>(`/requests/${r.id}/accept`, { method: 'POST' });
      queryClient.invalidateQueries({ queryKey: ['requests'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
      if (res.conversation) {
        upsertConversation(res.conversation);
        onClose();
        navigate(`/chats/${res.conversation.id}`);
      }
      toast(`Connected with ${r.sender?.name || 'user'}`);
    } catch (e) {
      toastError(e);
    } finally {
      setActingId(null);
    }
  };

  const decline = async (r: MessageRequest) => {
    setActingId(r.id);
    try {
      await api<{ request: MessageRequest }>(`/requests/${r.id}/reject`, { method: 'POST' });
      queryClient.invalidateQueries({ queryKey: ['requests'] });
      toast('Request declined');
    } catch (e) {
      toastError(e);
    } finally {
      setActingId(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Message Requests"
      width={460}
      footer={
        <button className="btn full" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="requests-modal">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'incoming', label: `Incoming (${pendingIncoming.length})` },
            { value: 'outgoing', label: `Sent (${outgoing.length})` },
          ]}
          className="wide"
        />

        {isLoading ? (
          <div className="center p-8">
            <Spinner size={24} />
          </div>
        ) : tab === 'incoming' ? (
          incoming.length === 0 ? (
            <div className="empty-requests">
              <UserCheck size={36} className="muted" />
              <p className="muted small">No message requests</p>
            </div>
          ) : (
            <div className="request-list">
              {incoming.map((r) => {
                const busy = actingId === r.id;
                const sender = r.sender;
                return (
                  <div key={r.id} className="request-card">
                    <div className="request-card-head">
                      <Avatar user={sender} size={42} />
                      <div className="grow">
                        <strong className="truncate">{sender?.name || 'Someone'}</strong>
                        <div className="small muted truncate">{sender?.email}</div>
                        {sender?.title && <div className="small muted truncate">{sender.title}</div>}
                      </div>
                      <span className="small muted">{listTime(r.created_at)}</span>
                    </div>

                    {r.note && <div className="request-note">“{r.note}”</div>}

                    {r.status === 'pending' ? (
                      <div className="request-actions">
                        <button className="btn btn-primary btn-sm grow" onClick={() => accept(r)} disabled={busy}>
                          {busy ? <Spinner size={14} /> : <Check size={14} />} Accept
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => decline(r)} disabled={busy}>
                          <X size={14} /> Decline
                        </button>
                      </div>
                    ) : (
                      <div className="request-status-badge">
                        {r.status === 'accepted' ? (
                          <span className="status-badge accepted">
                            <Check size={13} /> Accepted
                          </span>
                        ) : (
                          <span className="status-badge declined">
                            <UserX size={13} /> Declined
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : outgoing.length === 0 ? (
          <div className="empty-requests">
            <Clock size={36} className="muted" />
            <p className="muted small">No sent requests</p>
          </div>
        ) : (
          <div className="request-list">
            {outgoing.map((r) => {
              const recipient = r.recipient;
              return (
                <div key={r.id} className="request-card">
                  <div className="request-card-head">
                    <Avatar user={recipient} size={42} />
                    <div className="grow">
                      <strong className="truncate">{recipient?.name || 'Someone'}</strong>
                      <div className="small muted truncate">{recipient?.email}</div>
                    </div>
                    <span className="small muted">{listTime(r.created_at)}</span>
                  </div>

                  {r.note && <div className="request-note">“{r.note}”</div>}

                  <div className="request-status-badge">
                    {r.status === 'pending' ? (
                      <span className="status-badge pending">
                        <Clock size={13} /> Waiting for response
                      </span>
                    ) : r.status === 'accepted' ? (
                      <span className="status-badge accepted">
                        <Check size={13} /> Accepted
                      </span>
                    ) : (
                      <span className="status-badge declined">
                        <UserX size={13} /> Declined
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
