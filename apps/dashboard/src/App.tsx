import { createContext } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { User } from "./api";
import { Shell } from "./Shell";
import { AuditPage } from "./pages/Audit";
import { ChatPage } from "./pages/Chat";
import { ConsentPage } from "./pages/Consent";
import { KeysPage } from "./pages/Keys";
import { LoginPage } from "./pages/Login";
import { ServersPage } from "./pages/Servers";
import { StoresPage } from "./pages/Stores";
import { TeamPage } from "./pages/Team";

export const UserContext = createContext<User | null>(null);

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/oauth/consent" element={<ConsentPage />} />
      <Route element={<Shell />}>
        <Route path="/" element={<Navigate to="/servers" replace />} />
        <Route path="/servers" element={<ServersPage />} />
        <Route path="/stores" element={<StoresPage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/keys" element={<KeysPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/chat" element={<ChatPage />} />
      </Route>
    </Routes>
  );
}
