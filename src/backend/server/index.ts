import express from 'express';
import http from 'http';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { errorMiddleware } from '../middleware/index.ts';
import { createApiRouter } from '../routes/api.ts';
import { attachSocketServer } from '../websocket/index.ts';
import { TerminalService } from './terminal-service.ts';

export async function startTerminalServer(): Promise<void> {
  const app = express();
  const httpServer = http.createServer(app);
  const service = new TerminalService();

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createApiRouter(service));
  app.use(errorMiddleware);

  attachSocketServer(httpServer, service);

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT ?? 3000);
  await new Promise<void>((resolve) => {
    httpServer.listen(port, '0.0.0.0', () => {
      console.log(`GOLD BTC TERMINAL server listening on http://0.0.0.0:${port}`);
      resolve();
    });
  });

  // Start genuine market data feeds after server is listening
  void service.start();
}
