//+------------------------------------------------------------------+
//|                                    GoldBtcTerminalBridge.mq5      |
//|                   GOLD BTC TERMINAL - MQL5 Two-Way Bridge EA     |
//|                   DEMO SIGNAL EXECUTION & TRADE MANAGEMENT       |
//+------------------------------------------------------------------+
#property copyright "Gold BTC Terminal Architecture"
#property link      "https://github.com"
#property version   "3.00"
#property strict

#include <Trade\Trade.mqh>

input string   InpServerUrl            = "http://localhost:3000/api/mt5/bridge/ingest"; // Terminal Backend WebRequest URL
input string   InpApiToken             = "";                                             // Optional Bearer Token (if TERMINAL_API_TOKEN is set)
input int      InpHeartbeatSec         = 5;                                              // Account/Positions Sync Interval (Seconds)
input int      InpCommandPollSec       = 1;                                              // Trade Command Poll Interval (Seconds)
input int      InpTickIntervalMs       = 500;                                            // Minimum Tick Relay Interval (ms)
input int      InpErrorBackoffSec      = 5;                                              // Backoff After Connection Error (Seconds)
input bool     InpSendTicks            = true;                                           // Relay Live Ticks
input bool     InpSendPositions        = true;                                           // Relay Open MT5 Positions
input bool     InpEnableTradeExecution = true;                                           // Execute App BUY/SELL/SL/TP Commands on MT5
input bool     InpDemoAccountOnly      = true;                                           // Safety Guard: Block Real Accounts (Demo Only)

CTrade   g_trade;
datetime g_lastHeartbeat = 0;
datetime g_lastPoll = 0;
ulong    g_lastTickSentMs = 0;
datetime g_backoffUntil = 0;
bool     g_isConnected = false;

string   g_processedCmdIds[64];
int      g_processedCmdCursor = 0;

string EscapeJson(string value) {
   string out = value;
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   StringReplace(out, "\r", " ");
   StringReplace(out, "\n", " ");
   return out;
}

string GetAccountTradeModeString() {
   long mode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(mode == ACCOUNT_TRADE_MODE_DEMO) return "DEMO";
   if(mode == ACCOUNT_TRADE_MODE_CONTEST) return "CONTEST";
   if(mode == ACCOUNT_TRADE_MODE_REAL) return "REAL";
   return "UNKNOWN";
}

bool WasCommandProcessed(string cmdId) {
   if(StringLen(cmdId) == 0) return false;
   for(int i = 0; i < 64; i++) {
      if(g_processedCmdIds[i] == cmdId) return true;
   }
   return false;
}

void MarkCommandProcessed(string cmdId) {
   if(StringLen(cmdId) == 0) return;
   g_processedCmdIds[g_processedCmdCursor] = cmdId;
   g_processedCmdCursor = (g_processedCmdCursor + 1) % 64;
}

int VolumeDigits(double step) {
   if(step <= 0) return 2;
   double s = step;
   int d = 0;
   while(s < 0.9999 && d < 6) {
      s *= 10.0;
      d++;
   }
   return d;
}

double NormalizeLotVolume(string sym, double vol) {
   double minVol = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double maxVol = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double step   = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   if(step <= 0) step = 0.01;
   if(minVol <= 0) minVol = 0.01;
   if(maxVol <= 0) maxVol = 100.0;

   double clamped = MathMax(minVol, MathMin(maxVol, vol));
   double steps = MathFloor((clamped + 1e-9) / step);
   double norm = steps * step;
   if(norm < minVol) norm = minVol;
   return NormalizeDouble(norm, VolumeDigits(step));
}

void ConfigureFillingMode(string sym) {
   long filling = SymbolInfoInteger(sym, SYMBOL_FILLING_MODE);
   if((filling & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC) {
      g_trade.SetTypeFilling(ORDER_FILLING_IOC);
   } else if((filling & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK) {
      g_trade.SetTypeFilling(ORDER_FILLING_FOK);
   } else {
      g_trade.SetTypeFilling(ORDER_FILLING_RETURN);
   }
}

string ExtractJsonString(string obj, string key) {
   string pattern = "\"" + key + "\":\"";
   int start = StringFind(obj, pattern);
   if(start < 0) return "";
   start += StringLen(pattern);
   int end = start;
   int len = StringLen(obj);
   while(end < len) {
      ushort ch = StringGetCharacter(obj, end);
      if(ch == '\"') {
         if(end == start || StringGetCharacter(obj, end - 1) != '\\') break;
      }
      end++;
   }
   string raw = StringSubstr(obj, start, end - start);
   StringReplace(raw, "\\\"", "\"");
   StringReplace(raw, "\\\\", "\\");
   return raw;
}

double ExtractJsonNumber(string obj, string key, double fallback = 0.0) {
   string pattern = "\"" + key + "\":";
   int start = StringFind(obj, pattern);
   if(start < 0) return fallback;
   start += StringLen(pattern);
   int len = StringLen(obj);
   while(start < len && StringGetCharacter(obj, start) == ' ') start++;
   if(start >= len) return fallback;
   ushort first = StringGetCharacter(obj, start);
   if(first == 'n' || first == '\"') return fallback; // null or string
   int end = start;
   while(end < len) {
      ushort ch = StringGetCharacter(obj, end);
      if((ch >= '0' && ch <= '9') || ch == '.' || ch == '-' || ch == '+' || ch == 'e' || ch == 'E') {
         end++;
      } else {
         break;
      }
   }
   if(end <= start) return fallback;
   return StringToDouble(StringSubstr(obj, start, end - start));
}

ulong FindOpenTicketByCommentOrMagic(string sym, long magic, string commentTag) {
   int total = PositionsTotal();
   for(int i = total - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_COMMENT) == commentTag && StringLen(commentTag) > 0) {
         return ticket;
      }
   }
   for(int i = total - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == sym && PositionGetInteger(POSITION_MAGIC) == magic) {
         return ticket;
      }
   }
   return 0;
}

void SendCommandAck(string cmdId, bool success, ulong ticket, double execPrice, double execVol, int retcode, string errMsg) {
   string payload = StringFormat(
      "{\"type\":\"command_ack\",\"commandId\":\"%s\",\"success\":%s,\"ticket\":\"%I64u\",\"executedPrice\":%.5f,\"executedVolume\":%.4f,\"retcode\":%d,\"errorMessage\":\"%s\"}",
      EscapeJson(cmdId),
      success ? "true" : "false",
      ticket,
      execPrice,
      execVol,
      retcode,
      EscapeJson(errMsg)
   );
   SendWebRequest(payload, false);
}

void ExecuteSingleCommand(string cmdJson) {
   string cmdId = ExtractJsonString(cmdJson, "id");
   if(StringLen(cmdId) == 0 || WasCommandProcessed(cmdId)) return;
   MarkCommandProcessed(cmdId);

   string cmdType     = ExtractJsonString(cmdJson, "type");
   string sym         = ExtractJsonString(cmdJson, "brokerSymbol");
   if(StringLen(sym) == 0) sym = ExtractJsonString(cmdJson, "symbol");
   string side        = ExtractJsonString(cmdJson, "side");
   double volume      = ExtractJsonNumber(cmdJson, "volume", 0.01);
   double sl          = ExtractJsonNumber(cmdJson, "stopLoss", 0.0);
   double tp          = ExtractJsonNumber(cmdJson, "takeProfit", 0.0);
   string ticketStr   = ExtractJsonString(cmdJson, "mt5Ticket");
   ulong  ticket      = (ulong)StringToInteger(ticketStr);
   long   magic       = (long)ExtractJsonNumber(cmdJson, "magicNumber", 202611);
   ulong  deviation   = (ulong)MathMax(0, ExtractJsonNumber(cmdJson, "deviationPoints", 30));
   string comment     = ExtractJsonString(cmdJson, "comment");

   if(!InpEnableTradeExecution) {
      SendCommandAck(cmdId, false, ticket, 0, 0, -1, "EA trade execution is disabled (InpEnableTradeExecution=false)");
      return;
   }

   if(InpDemoAccountOnly) {
      long tradeMode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
      if(tradeMode != ACCOUNT_TRADE_MODE_DEMO && tradeMode != ACCOUNT_TRADE_MODE_CONTEST) {
         SendCommandAck(cmdId, false, ticket, 0, 0, -2, "Blocked by EA Demo-Only Safety Guard on REAL account");
         return;
      }
   }

   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)) {
      SendCommandAck(cmdId, false, ticket, 0, 0, -3, "Algo Trading is disabled in MetaTrader 5 toolbar or EA properties");
      return;
   }

   g_trade.SetExpertMagicNumber(magic);
   g_trade.SetDeviationInPoints(deviation);

   if(cmdType == "OPEN_ORDER") {
      if(!SymbolSelect(sym, true)) {
         SendCommandAck(cmdId, false, 0, 0, 0, -4, "Broker symbol not found: " + sym);
         return;
      }
      ConfigureFillingMode(sym);
      int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      double normVol = NormalizeLotVolume(sym, volume);
      double normSl  = sl > 0 ? NormalizeDouble(sl, digits) : 0.0;
      double normTp  = tp > 0 ? NormalizeDouble(tp, digits) : 0.0;

      bool ok = false;
      if(side == "BUY") {
         ok = g_trade.Buy(normVol, sym, 0.0, normSl, normTp, comment);
      } else {
         ok = g_trade.Sell(normVol, sym, 0.0, normSl, normTp, comment);
      }

      uint ret = g_trade.ResultRetcode();
      if(ok && (ret == TRADE_RETCODE_DONE || ret == TRADE_RETCODE_PLACED || ret == TRADE_RETCODE_DONE_PARTIAL)) {
         ulong posTicket = FindOpenTicketByCommentOrMagic(sym, magic, comment);
         if(posTicket == 0) posTicket = g_trade.ResultOrder();
         double execPrice = g_trade.ResultPrice();
         if(execPrice <= 0 && posTicket > 0 && PositionSelectByTicket(posTicket)) {
            execPrice = PositionGetDouble(POSITION_PRICE_OPEN);
         }
         double execVol = g_trade.ResultVolume() > 0 ? g_trade.ResultVolume() : normVol;
         Print("MT5 Demo Order Executed: ", side, " ", sym, " ", execVol, " @ ", execPrice, " Ticket #", posTicket);
         SendCommandAck(cmdId, true, posTicket, execPrice, execVol, (int)ret, "");
      } else {
         string err = g_trade.ResultRetcodeDescription();
         Print("MT5 Order Rejected: ", sym, " ret=", ret, " ", err);
         SendCommandAck(cmdId, false, 0, 0, 0, (int)ret, err);
      }
      SendAccountSnapshot();
      if(InpSendPositions) SendOpenPositions();
      return;
   }

   if(cmdType == "MODIFY_SLTP") {
      if(ticket == 0) ticket = FindOpenTicketByCommentOrMagic(sym, magic, comment);
      if(ticket == 0 || !PositionSelectByTicket(ticket)) {
         SendCommandAck(cmdId, false, ticket, 0, 0, -5, "Position not found for SL/TP modify");
         return;
      }
      string posSym = PositionGetString(POSITION_SYMBOL);
      int digits = (int)SymbolInfoInteger(posSym, SYMBOL_DIGITS);
      double targetSl = sl > 0 ? NormalizeDouble(sl, digits) : PositionGetDouble(POSITION_SL);
      double targetTp = tp > 0 ? NormalizeDouble(tp, digits) : PositionGetDouble(POSITION_TP);

      bool ok = g_trade.PositionModify(ticket, targetSl, targetTp);
      uint ret = g_trade.ResultRetcode();
      if(ok && (ret == TRADE_RETCODE_DONE || ret == TRADE_RETCODE_NO_CHANGES)) {
         Print("MT5 Position #", ticket, " Modified: SL=", targetSl, " TP=", targetTp);
         SendCommandAck(cmdId, true, ticket, PositionGetDouble(POSITION_PRICE_CURRENT), PositionGetDouble(POSITION_VOLUME), (int)ret, "");
      } else {
         SendCommandAck(cmdId, false, ticket, 0, 0, (int)ret, g_trade.ResultRetcodeDescription());
      }
      if(InpSendPositions) SendOpenPositions();
      return;
   }

   if(cmdType == "CLOSE_PARTIAL") {
      if(ticket == 0) ticket = FindOpenTicketByCommentOrMagic(sym, magic, comment);
      if(ticket == 0 || !PositionSelectByTicket(ticket)) {
         SendCommandAck(cmdId, false, ticket, 0, 0, -5, "Position not found for partial close");
         return;
      }
      string posSym = PositionGetString(POSITION_SYMBOL);
      ConfigureFillingMode(posSym);
      double curVol = PositionGetDouble(POSITION_VOLUME);
      double closeVol = NormalizeLotVolume(posSym, MathMin(curVol, volume));

      bool ok = g_trade.PositionClosePartial(ticket, closeVol, deviation);
      uint ret = g_trade.ResultRetcode();
      if(ok && (ret == TRADE_RETCODE_DONE || ret == TRADE_RETCODE_DONE_PARTIAL)) {
         Print("MT5 Partial Close #", ticket, ": ", closeVol, " lot @ ", g_trade.ResultPrice());
         SendCommandAck(cmdId, true, ticket, g_trade.ResultPrice(), closeVol, (int)ret, "");
      } else {
         SendCommandAck(cmdId, false, ticket, 0, 0, (int)ret, g_trade.ResultRetcodeDescription());
      }
      SendAccountSnapshot();
      if(InpSendPositions) SendOpenPositions();
      return;
   }

   if(cmdType == "CLOSE_POSITION") {
      if(ticket == 0) ticket = FindOpenTicketByCommentOrMagic(sym, magic, comment);
      if(ticket == 0 || !PositionSelectByTicket(ticket)) {
         SendCommandAck(cmdId, false, ticket, 0, 0, -5, "Position not found for close");
         return;
      }
      string posSym = PositionGetString(POSITION_SYMBOL);
      ConfigureFillingMode(posSym);
      double curVol = PositionGetDouble(POSITION_VOLUME);

      bool ok = g_trade.PositionClose(ticket, deviation);
      uint ret = g_trade.ResultRetcode();
      if(ok && ret == TRADE_RETCODE_DONE) {
         Print("MT5 Position Closed #", ticket, " @ ", g_trade.ResultPrice());
         SendCommandAck(cmdId, true, ticket, g_trade.ResultPrice(), curVol, (int)ret, "");
      } else {
         SendCommandAck(cmdId, false, ticket, 0, 0, (int)ret, g_trade.ResultRetcodeDescription());
      }
      SendAccountSnapshot();
      if(InpSendPositions) SendOpenPositions();
      return;
   }
}

void ProcessServerCommands(string responseBody) {
   int cmdKeyPos = StringFind(responseBody, "\"commands\":[");
   if(cmdKeyPos < 0) return;
   int arrStart = cmdKeyPos + StringLen("\"commands\":[");
   int len = StringLen(responseBody);
   if(arrStart >= len) return;

   int i = arrStart;
   while(i < len) {
      ushort ch = StringGetCharacter(responseBody, i);
      if(ch == ']') break;
      if(ch == '{') {
         int depth = 0;
         bool inStr = false;
         int objStart = i;
         int objEnd = -1;
         for(int j = i; j < len; j++) {
            ushort c = StringGetCharacter(responseBody, j);
            if(c == '\"' && (j == 0 || StringGetCharacter(responseBody, j - 1) != '\\')) {
               inStr = !inStr;
            } else if(!inStr) {
               if(c == '{') depth++;
               else if(c == '}') {
                  depth--;
                  if(depth == 0) {
                     objEnd = j;
                     break;
                  }
               }
            }
         }
         if(objEnd > objStart) {
            string objStr = StringSubstr(responseBody, objStart, objEnd - objStart + 1);
            ExecuteSingleCommand(objStr);
            i = objEnd + 1;
            continue;
         } else {
            break;
         }
      }
      i++;
   }
}

int OnInit() {
   int pollSec = MathMax(1, InpCommandPollSec);
   Print("GoldBtcTerminalBridge EA v3.00 initialized (TradeExecution=", InpEnableTradeExecution ? "ON" : "OFF",
         ", DemoOnly=", InpDemoAccountOnly ? "ON" : "OFF",
         ", AccountMode=", GetAccountTradeModeString(), ").");
   Print("Target URL: ", InpServerUrl);
   EventSetTimer(pollSec);

   SendHeartbeat();
   SendAccountSnapshot();
   if(InpSendPositions) SendOpenPositions();
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) {
   EventKillTimer();
   Print("GoldBtcTerminalBridge EA deinitialized. Reason code: ", reason);
}

void OnTick() {
   if(!InpSendTicks) return;
   if(TimeCurrent() < g_backoffUntil) return;

   ulong nowMs = GetTickCount64();
   if(nowMs - g_lastTickSentMs < (ulong)MathMax(100, InpTickIntervalMs)) return;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick)) return;

   g_lastTickSentMs = nowMs;
   string payload = StringFormat(
      "{\"type\":\"tick\",\"symbol\":\"%s\",\"bid\":%.5f,\"ask\":%.5f,\"last\":%.5f,\"time\":%I64d}",
      EscapeJson(_Symbol), tick.bid, tick.ask, tick.last, tick.time_msc
   );

   SendWebRequest(payload, true);
}

void OnTimer() {
   datetime now = TimeCurrent();
   if(now < g_backoffUntil) return;

   if(now - g_lastHeartbeat >= MathMax(1, InpHeartbeatSec)) {
      g_lastHeartbeat = now;
      g_lastPoll = now;
      SendHeartbeat();
      SendAccountSnapshot();
      if(InpSendPositions) SendOpenPositions();
   } else if(now - g_lastPoll >= MathMax(1, InpCommandPollSec)) {
      g_lastPoll = now;
      SendHeartbeat();
   }
}

void SendHeartbeat() {
   string payload = StringFormat(
      "{\"type\":\"heartbeat\",\"terminalVersion\":\"MT5 Build %d\",\"bridgeVersion\":\"3.00\",\"tradeMode\":\"%s\",\"login\":%I64d,\"server\":\"%s\",\"broker\":\"%s\"}",
      (int)TerminalInfoInteger(TERMINAL_BUILD),
      GetAccountTradeModeString(),
      AccountInfoInteger(ACCOUNT_LOGIN),
      EscapeJson(AccountInfoString(ACCOUNT_SERVER)),
      EscapeJson(AccountInfoString(ACCOUNT_COMPANY))
   );
   SendWebRequest(payload, true);
}

void SendAccountSnapshot() {
   string payload = StringFormat(
      "{\"type\":\"account\",\"terminalVersion\":\"MT5 Build %d\",\"tradeMode\":\"%s\",\"login\":%I64d,\"server\":\"%s\",\"company\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"margin\":%.2f,\"freeMargin\":%.2f,\"leverage\":%d,\"currency\":\"%s\"}",
      (int)TerminalInfoInteger(TERMINAL_BUILD),
      GetAccountTradeModeString(),
      AccountInfoInteger(ACCOUNT_LOGIN),
      EscapeJson(AccountInfoString(ACCOUNT_SERVER)),
      EscapeJson(AccountInfoString(ACCOUNT_COMPANY)),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_MARGIN),
      AccountInfoDouble(ACCOUNT_MARGIN_FREE),
      (int)AccountInfoInteger(ACCOUNT_LEVERAGE),
      EscapeJson(AccountInfoString(ACCOUNT_CURRENCY))
   );
   SendWebRequest(payload, true);
}

void SendOpenPositions() {
   int total = PositionsTotal();
   string posJson = "[";
   int appended = 0;
   for(int i=0; i<total; i++) {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0) {
         if(appended > 0) posJson += ",";
         posJson += StringFormat(
            "{\"ticket\":\"%I64u\",\"symbol\":\"%s\",\"type\":\"%s\",\"volume\":%.4f,\"openPrice\":%.5f,\"currentPrice\":%.5f,\"sl\":%.5f,\"tp\":%.5f,\"profit\":%.2f,\"magic\":%I64d,\"comment\":\"%s\"}",
            ticket,
            EscapeJson(PositionGetString(POSITION_SYMBOL)),
            PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL",
            PositionGetDouble(POSITION_VOLUME),
            PositionGetDouble(POSITION_PRICE_OPEN),
            PositionGetDouble(POSITION_PRICE_CURRENT),
            PositionGetDouble(POSITION_SL),
            PositionGetDouble(POSITION_TP),
            PositionGetDouble(POSITION_PROFIT),
            PositionGetInteger(POSITION_MAGIC),
            EscapeJson(PositionGetString(POSITION_COMMENT))
         );
         appended++;
      }
   }
   posJson += "]";

   string payload = StringFormat("{\"type\":\"positions\",\"positions\":%s}", posJson);
   SendWebRequest(payload, true);
}

bool SendWebRequest(string jsonPayload, bool parseCommands) {
   string headers = "Content-Type: application/json\r\nAccept: application/json\r\n";
   if(StringLen(InpApiToken) > 0 && InpApiToken != "CHANGE_ME_SECRET_TOKEN") {
      headers += "Authorization: Bearer " + InpApiToken + "\r\n";
   }

   char post[];
   char result[];
   string resultHeaders;

   int len = StringToCharArray(jsonPayload, post, 0, WHOLE_ARRAY, CP_UTF8);
   if(len > 0) {
      ArrayResize(post, len - 1);
   }

   ResetLastError();
   int res = WebRequest("POST", InpServerUrl, headers, 4000, post, result, resultHeaders);
   if(res == 200) {
      if(!g_isConnected) {
         g_isConnected = true;
         Print("MT5 Bridge CONNECTED to ", InpServerUrl);
      }
      if(parseCommands && ArraySize(result) > 0) {
         string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
         ProcessServerCommands(resp);
      }
      return true;
   }

   g_isConnected = false;
   g_backoffUntil = TimeCurrent() + MathMax(1, InpErrorBackoffSec);
   int err = GetLastError();

   if(res == -1) {
      if(err == 4014) {
         Print("WebRequest blocked (Error 4014). Open MT5 -> Tools -> Options -> Expert Advisors -> enable 'Allow WebRequest for listed URL' and add the base origin of: ", InpServerUrl);
      } else {
         Print("WebRequest error: code -1 (LastError=", err, ") URL: ", InpServerUrl, " — Ensure the GOLD BTC TERMINAL server is running and reachable from this PC.");
      }
   } else {
      string body = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      Print("WebRequest HTTP ", res, " URL: ", InpServerUrl, " Response: ", body);
   }
   return false;
}
