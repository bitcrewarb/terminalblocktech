import type { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import type { InstrumentSymbol, Timeframe } from '../../shared/types/index.ts';
import { isValidInstrument, isValidTimeframe } from '../../shared/validators/index.ts';
import { parseCookieHeader, SESSION_COOKIE_NAME } from '../middleware/index.ts';
import type { TerminalService } from '../server/terminal-service.ts';

export function attachSocketServer(httpServer: HttpServer, service: TerminalService): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes('.run.app')) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS policy'));
        }
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.use((socket, next) => {
    const authToken =
      typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : null;
    const authHeader = socket.handshake.headers.authorization;
    const bearerToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : null;
    const cookies = parseCookieHeader(socket.handshake.headers.cookie);
    const cookieToken = cookies[SESSION_COOKIE_NAME] || null;

    const token = authToken || bearerToken || cookieToken;
    const user = service.authService.verifySession(token);
    if (!user) {
      next(new Error('Unauthorized: Valid session required for terminal WebSocket stream'));
      return;
    }
    socket.data.user = user;
    next();
  });

  service.setBroadcastSink({
    isStreamSubscribed: (symbol, timeframe) => {
      const room = io.sockets.adapter.rooms.get(`stream:${symbol}:${timeframe}`);
      return (room?.size ?? 0) > 0;
    },
    onQuote: (quote) => {
      io.emit('market:quote', quote);
    },
    onCandle: (symbol, timeframe, candle) => {
      io.to(`stream:${symbol}:${timeframe}`).emit('market:candle', {
        symbol,
        timeframe,
        candle,
      });
    },
    onSnapshot: (snapshot) => {
      io.to(`stream:${snapshot.symbol}:${snapshot.timeframe}`).emit('analysis:snapshot', snapshot);
    },
    onZoneInteractions: (symbol, timeframe, interactions) => {
      io.to(`stream:${symbol}:${timeframe}`).emit('monitor:zones', {
        symbol,
        timeframe,
        interactions,
      });
    },
    onEvents: (events) => {
      io.emit('monitor:events', events);
    },
    onAlert: (alert) => {
      io.emit('alert:triggered', alert);
    },
    onAlertRulesUpdated: (rules) => {
      io.emit('alert:rules', rules);
    },
    onAlertEnabledUpdated: (enabled) => {
      io.emit('alert:enabled', { enabled });
    },
    onAlertHistoryCleared: () => {
      io.emit('alert:cleared');
    },
    onProviderStatus: (status) => {
      io.emit('provider:status', status);
    },
    onSignalUpdated: (signal) => {
      io.emit('signal:updated', signal);
    },
    onSignalsDeleted: (payload) => {
      io.emit('signal:deleted', payload);
    },
    onSignalNotification: (notification) => {
      io.emit('signal:notification', notification);
    },
    onSignalDiagnostics: (diagnostics) => {
      io.emit('signal:diagnostics', diagnostics);
    },
    onSignalPerformance: (performance) => {
      io.emit('signal:performance', performance);
    },
    onSignalSettingsUpdated: (settings) => {
      io.emit('signal:settings', settings);
    },
    onStrategyBasketUpdated: (basket) => {
      io.emit('signal:basket', basket);
    },
    onDiscoveryProgress: (progress) => {
      io.emit('discovery:progress', progress);
    },
    onJournalUpdated: (entry) => {
      io.emit('journal:updated', entry);
    },
    onPaperUpdated: (payload) => {
      io.emit('paper:updated', payload);
    },
    onMt5StatusUpdated: (status) => {
      io.emit('mt5:status', status);
    },
    onMt5ExecutionUpdated: (overview) => {
      io.emit('mt5:execution', overview);
    },
  });

  io.on('connection', (socket) => {
    socket.emit('terminal:overview', service.getOverview());

    let currentRoom: string | null = null;

    socket.on(
      'subscribe:chart',
      async (payload: { symbol: InstrumentSymbol; timeframe: Timeframe }) => {
        if (!payload || !isValidInstrument(payload.symbol) || !isValidTimeframe(payload.timeframe)) {
          return;
        }
        const nextRoom = `stream:${payload.symbol}:${payload.timeframe}`;
        if (currentRoom && currentRoom !== nextRoom) {
          await socket.leave(currentRoom);
        }
        currentRoom = nextRoom;
        await socket.join(nextRoom);

        const snap = await service.getSnapshot(payload.symbol, payload.timeframe);
        socket.emit('analysis:snapshot', snap);
      }
    );
  });

  return io;
}
