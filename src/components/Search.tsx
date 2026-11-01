import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api } from '../lib/api';
import { conversationTitle, labelTitle, listTime } from '../lib/format';
import { useConversations, useMe } from '../lib/store';
import type { Message } from '../lib/types';
import { Avatar, ConvAvatar, Modal, Spinner } from './ui';

function useDebounced<T>(v: T, ms = 220) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function Highlight({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0 || !q) return <>{text.slice(0, 140)}</>;
  const start = Math.max(0, i - 40);
  return (
    <>
      {start > 0 && '…'}
      {text.slice(start, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length, i + q.length + 90)}
    </>
  );
}

export function SearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const { data: conversations } = useConversations();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const { data, isFetching } = useQuery({
    queryKey: ['search', dq],
    queryFn: () => api<{ messages: Message[] }>(`/search?q=${encodeURIComponent(dq)}`).then((r) => r.messages),
    enabled: open && dq.length >= 2,
  });
  useEffect(() => {
    if (open) setQ('');
  }, [open]);

  const convMatches = q.trim()
    ? (conversations ?? []).filter((c) => conversationTitle(c, me?.id).toLowerCase().includes(q.trim().toLowerCase())).slice(0, 5)
    : [];
  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  return (
    <Modal open={open} onClose={onClose} className="search-modal" width={620}>
      <div className="search-input-big">
        <Search size={19} />
        <input autoFocus placeholder="Search messages, people and groups…" value={q} onChange={(e) => setQ(e.target.value)} />
        {isFetching && <Spinner size={15} />}
      </div>
      <div className="search-results">
        {convMatches.length > 0 && (
          <>
            <div className="result-group">Conversations</div>
            {convMatches.map((c) => (
              <button key={c.id} className="result" onClick={() => go(`/chats/${c.id}`)}>
                <ConvAvatar label={{ ...c, name: conversationTitle(c, me?.id) }} members={c.members} meId={me?.id} size={32} />
                <strong>{conversationTitle(c, me?.id)}</strong>
              </button>
            ))}
          </>
        )}
        {(data?.length ?? 0) > 0 && (
          <>
            <div className="result-group">Messages</div>
            {data!.map((m) => (
              <button key={m.id} className="result" onClick={() => go(`/chats/${m.conversation_id}?m=${m.id}`)}>
                <Avatar user={m.user} size={32} />
                <span className="grow">
                  <span className="result-meta">
                    <strong>{m.user?.name}</strong> in {labelTitle(m.conversation)} · {listTime(m.created_at)}
                  </span>
                  <span className="result-text">
                    <Highlight text={m.body} q={dq} />
                  </span>
                </span>
              </button>
            ))}
          </>
        )}
        {dq.length >= 2 && !isFetching && !data?.length && !convMatches.length && <p className="muted center pad">No results for “{dq}”.</p>}
        {!q && <p className="muted center pad">Tip: press Ctrl K anywhere to search.</p>}
      </div>
    </Modal>
  );
}
