import { useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { getToken, setToken, setUnauthorizedHandler } from './lib/api';
import { initPlatform } from './lib/platform';
import { connectRealtime, disconnectRealtime } from './lib/socket';
import { queryClient, useMe } from './lib/store';
import { Layout } from './components/Layout';
import { Loader } from './components/ui';
import { LoginPage, RegisterPage } from './pages/Auth';
import { ChatsPage } from './pages/Chats';
import { LibraryPage, TasksPage, TodayPage } from './pages/Work';
import { MePage } from './pages/Me';

function RequireAuth() {
  const token = getToken();
  if (!token) return <Navigate to="/login" replace />;
  return <Session />;
}

function Session() {
  const { data: me, isLoading, error } = useMe();
  useEffect(() => {
    if (!me) return;
    connectRealtime(me);
    return () => disconnectRealtime();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);
  if (isLoading) return <Loader />;
  if (error && !me) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function GuestOnly() {
  return getToken() ? <Navigate to="/chats" replace /> : <Outlet />;
}

export function App() {
  const navigate = useNavigate();
  useEffect(() => {
    initPlatform(navigate);
    setUnauthorizedHandler(() => {
      setToken(null);
      disconnectRealtime();
      queryClient.clear();
      navigate('/login', { replace: true });
    });
  }, [navigate]);

  return (
    <Routes>
      <Route element={<GuestOnly />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/chats" replace />} />
          <Route path="chats" element={<ChatsPage />} />
          <Route path="chats/:id" element={<ChatsPage />} />
          <Route path="today" element={<TodayPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="library" element={<LibraryPage />} />
          <Route path="me" element={<MePage />} />
          <Route path="*" element={<Navigate to="/chats" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
