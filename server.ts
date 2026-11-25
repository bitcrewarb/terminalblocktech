import 'dotenv/config';
import { startTerminalServer } from './src/backend/server/index.ts';

startTerminalServer().catch((err) => {
  console.error('Failed to start GOLD BTC TERMINAL server:', err);
  process.exit(1);
});
