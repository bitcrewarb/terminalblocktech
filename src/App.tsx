import { LoginPage } from './frontend/auth/LoginPage.tsx';
import { TerminalLayout } from './frontend/layouts/TerminalLayout.tsx';
import { AuthProvider, useAuth } from './frontend/state/auth-context.tsx';
import { TerminalProvider } from './frontend/state/terminal-context.tsx';

function TerminalGate() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0B0E14] text-[#8B949E]">
        <div className="border border-[#222938] bg-[#12161F] px-6 py-4 font-mono text-xs tracking-wider text-[#C9D1D9]">
          VERIFYING TERMINAL SESSION...
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return (
    <TerminalProvider>
      <TerminalLayout />
    </TerminalProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <TerminalGate />
    </AuthProvider>
  );
}
