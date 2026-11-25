import { AlertCircle, Eye, EyeOff, Lock, Mail, ShieldCheck } from 'lucide-react';
import React, { useState } from 'react';
import { useAuth } from '../state/auth-context.tsx';

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Please enter your email and password.');
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const result = await login(email, password);
      if (!result.ok) {
        setError(result.error || 'Invalid username or password.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen w-screen flex-col items-center justify-center bg-[#0B0E14] px-4 text-[#E6EDF3]">
      <div className="w-full max-w-md border border-[#222938] bg-[#12161F] shadow-2xl">
        <div className="border-b border-[#222938] px-6 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center border border-[#38BDF8]/40 bg-[#0B0E14] text-[#38BDF8]">
                <ShieldCheck className="h-4 w-4" />
              </div>
              <div>
                <h1 className="text-sm font-bold tracking-wider text-[#E6EDF3]">
                  GOLD BTC TERMINAL
                </h1>
                <p className="font-mono text-[11px] text-[#8B949E]">
                  INSTITUTIONAL MARKET INTELLIGENCE
                </p>
              </div>
            </div>
            <span className="border border-[#0ECB81]/40 bg-[#0ECB81]/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-[#0ECB81]">
              PAPER MODE
            </span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-6">
          <div>
            <h2 className="text-base font-semibold text-[#E6EDF3]">Operator Sign In</h2>
            <p className="mt-1 text-xs text-[#8B949E]">
              Authenticate to access live charts, strategy discovery, signals, and paper execution.
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 border border-[#F6465D]/60 bg-[#F6465D]/10 px-3 py-2.5 text-xs text-[#F6465D]"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-1.5">
            <label
              htmlFor="login-email"
              className="block font-mono text-[11px] uppercase tracking-wider text-[#8B949E]"
            >
              Username / Email
            </label>
            <div className="relative flex items-center border border-[#222938] bg-[#0B0E14] focus-within:border-[#38BDF8]">
              <Mail className="ml-3 h-4 w-4 shrink-0 text-[#8B949E]" />
              <input
                id="login-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="operator@domain.com"
                className="w-full bg-transparent px-3 py-2.5 font-mono text-xs text-[#E6EDF3] placeholder-[#4B5563] outline-none"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="login-password"
              className="block font-mono text-[11px] uppercase tracking-wider text-[#8B949E]"
            >
              Password
            </label>
            <div className="relative flex items-center border border-[#222938] bg-[#0B0E14] focus-within:border-[#38BDF8]">
              <Lock className="ml-3 h-4 w-4 shrink-0 text-[#8B949E]" />
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                className="w-full bg-transparent px-3 py-2.5 font-mono text-xs text-[#E6EDF3] placeholder-[#4B5563] outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="mr-2.5 p-1 text-[#8B949E] hover:text-[#E6EDF3] cursor-pointer"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="mt-2 flex w-full items-center justify-center gap-2 border border-[#38BDF8] bg-[#38BDF8]/15 px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-[#38BDF8] transition-colors hover:bg-[#38BDF8]/25 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
          >
            {submitting ? 'Authenticating...' : 'Sign In to Terminal'}
          </button>
        </form>

        <div className="flex items-center justify-between border-t border-[#222938] bg-[#0B0E14]/60 px-6 py-3 font-mono text-[10px] text-[#8B949E]">
          <span>XAUUSD · XAGUSD · BTCUSDT · ETHUSDT</span>
          <span>SECURE SESSION</span>
        </div>
      </div>
    </div>
  );
}
