import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BookOpen, CheckSquare, MessageCircle, Search, Sun, WifiOff } from 'lucide-react';
import { cx, today as todayStr } from '../lib/format';
import { useConnection, useConversations, useMe, useToday } from '../lib/store';
import { Avatar, Logo } from './ui';
import { SearchModal } from './Search';
import { WorkProvider } from './WorkForms';
import { CallModal } from './CallModal';
import { IncomingCallBanner } from './IncomingCallBanner';

export function Layout() {
  const { data: me } = useMe();
  const { data: conversations } = useConversations();
  const { data: today } = useToday();
  const connection = useConnection();
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState(false);
  const inChat = /^\/chats\/\d+/.test(location.pathname);
  const unread = (conversations ?? []).filter((c) => !c.muted && c.unread_count > 0).length;
  const dueToday = today ? today.my_tasks.filter((t) => t.due_date && t.due_date <= todayStr()).length : 0;

  useEffect(() => {
    const total = (conversations ?? []).reduce((s, c) => s + (c.muted ? 0 : c.unread_count), 0);
    document.title = total ? `(${total}) Kizuna` : 'Kizuna';
  }, [conversations]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch((s) => !s);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const nav = [
    { to: '/chats', label: 'Chats', icon: MessageCircle, badge: unread },
    { to: '/today', label: 'Today', icon: Sun, badge: dueToday },
    { to: '/tasks', label: 'Tasks', icon: CheckSquare, badge: 0 },
    { to: '/library', label: 'Library', icon: BookOpen, badge: 0 },
  ];

  return (
    <WorkProvider>
      <div className={cx('app', inChat && 'in-chat')}>
        <nav className="rail">
          <button className="rail-logo" onClick={() => navigate('/chats')} aria-label="Kizuna home">
            <Logo size={38} />
          </button>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} className="rail-item">
              <span className="rail-icon">
                <n.icon size={22} />
                {n.badge > 0 && <span className="badge-dot">{n.badge}</span>}
              </span>
              <span>{n.label}</span>
            </NavLink>
          ))}
          <span className="spacer" />
          <button className="rail-item" onClick={() => setSearch(true)} title="Search (Ctrl K)">
            <span className="rail-icon">
              <Search size={21} />
            </span>
            <span>Search</span>
          </button>
          <NavLink to="/me" className="rail-item rail-me" title="Profile & settings">
            <Avatar user={me} size={36} />
          </NavLink>
        </nav>

        <main className="app-main">
          {connection === 'offline' && (
            <div className="offline-banner">
              <WifiOff size={14} /> Reconnecting… messages will sync when you’re back online.
            </div>
          )}
          <Outlet context={{ openSearch: () => setSearch(true) }} />
        </main>

        <nav className="tabbar">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} className="tab-item">
              <span className="rail-icon">
                <n.icon size={22} />
                {n.badge > 0 && <span className="badge-dot">{n.badge}</span>}
              </span>
              <span>{n.label}</span>
            </NavLink>
          ))}
          <NavLink to="/me" className="tab-item">
            <Avatar user={me} size={24} />
            <span>Me</span>
          </NavLink>
        </nav>
        <IncomingCallBanner />
        <CallModal />
        <SearchModal open={search} onClose={() => setSearch(false)} />
      </div>
    </WorkProvider>
  );
}
