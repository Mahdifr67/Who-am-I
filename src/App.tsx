import { useState, useEffect, useRef } from "react";
import { initializeApp } from "firebase/app";
import {
  getDatabase,
  ref,
  set,
  get,
  onValue,
  update,
  push,
  off,
  runTransaction,
  onDisconnect as fbOnDisconnect,
} from "firebase/database";
import { FAMOUS_PERSONS } from "./persons";
import {
  Panel, Row, Label, Input, Btn, VoteBtn, Alert, Timer,
  ToastContainer, showToast, PersonSuggest,
  FloatingBar,
  PlayerRow, PageShell, T, FONT,
} from "./components";

// ── Syne font ─────────────────────────────────────────────────────────────────
const _fl = document.createElement("link");
_fl.rel = "stylesheet";
_fl.href = "https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&display=swap";
document.head.appendChild(_fl);

// ── FIREBASE CONFIG ───────────────────────────────────────────────────────────

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL:       import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);


// ── TYPES ─────────────────────────────────────────────────────────────────────
type GamePhase =
  | "lobby" | "verification" | "playing" | "question_voting"
  | "results_shown" | "name_guess_voting" | "winner_check" | "winner_voting" | "ended";

interface Player {
  id: string; name: string; isHost: boolean;
  assignedPerson?: string; isWinner?: boolean; isEliminated?: boolean; turnOrder?: number;
  online?: boolean; // set via onDisconnect presence
}
interface Question {
  id: string; askerId: string; askerName: string;
  text: string; votes: Record<string, "yes" | "no" | "dont_know">; isNameGuess?: boolean;
}
interface VerificationRound {
  playerId: string; playerName: string; assignedPerson: string; votes: Record<string, "yes" | "no">;
}
interface GameState {
  phase: GamePhase; players: Record<string, Player>; hostId: string;
  currentQuestion?: Question; verificationQueue: VerificationRound[];
  currentVerificationIndex: number; currentTurnPlayerId?: string;
  turnNumber: number; winners: string[]; winnerVotes?: Record<string, string>;
  usedPersons: string[]; gameCode: string;
  timerEndsAt?: number; // unix ms — set by host when a voting phase begins
}

// ── TIMER ─────────────────────────────────────────────────────────────────────
const TIMER_MS        = 30_000; // 30 s for voting phases
const PLAYING_TIMER_MS = 60_000; // 60 s for the asking phase

// ── HELPERS ───────────────────────────────────────────────────────────────────
function generateCode() { return Math.random().toString(36).substring(2, 7).toUpperCase(); }
function pickRandom<T>(arr: T[], exclude: T[] = []): T {
  const pool = arr.filter((x) => !exclude.includes(x));
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── MAIN APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [screen,       setScreen]       = useState<"home" | "game">("home");
  const [playerName,   setPlayerName]   = useState("");
  const [gameCode,     setGameCode]     = useState("");
  const [joinCode,     setJoinCode]     = useState("");
  const [playerId,     setPlayerId]     = useState<string | null>(null);
  const [gameState,    setGameState]    = useState<GameState | null>(null);
  const [myVote,       setMyVote]       = useState<string | null>(null);
  const [questionText, setQuestionText] = useState("");
  const [error,        setError]        = useState("");
  const [loading,      setLoading]      = useState(false);
  const gameRef     = useRef<ReturnType<typeof ref> | null>(null);
  const presenceRef = useRef<ReturnType<typeof ref> | null>(null);

  useEffect(() => {
    if (!gameCode || !playerId) return;
    const r = ref(db, `games/${gameCode}`);
    gameRef.current = r;
    const unsub = onValue(r, (snap) => {
      if (snap.exists()) setGameState(snap.val() as GameState);
    });

    // ── Presence: mark online; auto-mark offline on disconnect ──────────────
    const onlineRef = ref(db, `games/${gameCode}/players/${playerId}/online`);
    presenceRef.current = onlineRef;
    set(onlineRef, true);
    fbOnDisconnect(onlineRef).set(false);

    return () => {
      off(r, "value", unsub);
      set(onlineRef, false); // clean up on intentional unmount
    };
  }, [gameCode, playerId]);

  useEffect(() => {
    setMyVote(null);
  }, [
    gameState?.phase,
    gameState?.currentQuestion?.id,
    gameState?.currentVerificationIndex,
    // Clear vote when the person in the current verification round changes
    gameState?.verificationQueue?.[gameState?.currentVerificationIndex ?? 0]?.assignedPerson,
  ]);

  // ── HOST-ONLY WATCHER — single authority for all vote resolution ─────────
  // Runs on every gameState change. Uses a runTransaction lock so that even
  // if the host reconnects mid-vote the resolve fires exactly once.
  useEffect(() => {
    if (!gameState || !playerId) return;
    if (gameState.hostId !== playerId) return; // non-hosts never resolve

    const { phase } = gameState;

    // Helper: count online (or all-offline fallback) eligible voters
    function eligibleCount(gs: GameState, excludeId?: string): number {
      return Object.values(gs.players).filter(
        (p) => !p.isEliminated && p.id !== excludeId && p.online !== false
      ).length || // fallback: if everyone is offline count all non-eliminated
      Object.values(gs.players).filter(
        (p) => !p.isEliminated && p.id !== excludeId
      ).length;
    }

    async function maybeResolve() {
      const snap = await get(ref(db, `games/${gameCode}`));
      if (!snap.exists()) return;
      const gs = snap.val() as GameState;
      if (gs.phase !== phase) return; // already moved on

      if (gs.phase === "verification") {
        const idx   = gs.currentVerificationIndex;
        const round = gs.verificationQueue?.[idx];
        if (!round) return;
        const votes    = round.votes ?? {};
        const eligible = eligibleCount(gs, round.playerId);
        const cast     = Object.keys(votes).length;
        const timerUp  = !!(gs.timerEndsAt && Date.now() >= gs.timerEndsAt);
        if (cast === 0 && !timerUp) return;
        if (cast >= eligible || timerUp) {
          // Use different lock keys: timer-expiry uses "t:" prefix, all-voted uses "v:"
          const lockKey = timerUp && cast < eligible
            ? `t:verification${idx}:${gs.timerEndsAt}`
            : `v:verification${idx}:${cast}`;
          const lockRef = ref(db, `games/${gameCode}/resolveLock`);
          await runTransaction(lockRef, (current) => {
            if (current === lockKey) return;
            return lockKey;
          }).then(async (result) => {
            if (!result.committed) return;
            if (cast === 0) {
              await update(ref(db, `games/${gameCode}`), { phase: "ended" });
            } else {
              await resolveVerification(gs);
            }
          });
        }
      } else if (gs.phase === "question_voting") {
        const q = gs.currentQuestion;
        if (!q) return;
        const votes    = q.votes ?? {};
        const eligible = eligibleCount(gs, q.askerId);
        const cast     = Object.keys(votes).length;
        const timerUp  = !!(gs.timerEndsAt && Date.now() >= gs.timerEndsAt);
        if (cast === 0 && !timerUp) return;
        if (cast >= eligible || timerUp) {
          const lockKey = timerUp && cast < eligible
            ? `t:question${q.id}:${gs.timerEndsAt}`
            : `v:question${q.id}:${cast}`;
          const lockRef = ref(db, `games/${gameCode}/resolveLock`);
          await runTransaction(lockRef, (current) => {
            if (current === lockKey) return;
            return lockKey;
          }).then(async (result) => {
            if (!result.committed) return;
            if (cast === 0) {
              await update(ref(db, `games/${gameCode}`), { phase: "ended" });
            } else {
              await resolveQuestion(gs);
            }
          });
        }
      } else if (gs.phase === "winner_check") {
        const votes    = gs.winnerVotes ?? {};
        const eligible = eligibleCount(gs);
        const cast     = Object.keys(votes).length;
        const timerUp  = !!(gs.timerEndsAt && Date.now() >= gs.timerEndsAt);
        if (cast === 0 && !timerUp) return;
        if (cast >= eligible || timerUp) {
          const lockKey = timerUp && cast < eligible
            ? `t:winner_check:${gs.timerEndsAt}`
            : `v:winner_check:${cast}`;
          const lockRef = ref(db, `games/${gameCode}/resolveLock`);
          await runTransaction(lockRef, (current) => {
            if (current === lockKey) return;
            return lockKey;
          }).then(async (result) => {
            if (!result.committed) return;
            if (cast === 0) {
              await update(ref(db, `games/${gameCode}`), { phase: "ended" });
            } else {
              await resolveWinnerCheck(gs);
            }
          });
        }
      }
    }

    // Also handle the playing phase timer (asker took too long → skip their turn)
    if (phase === "playing") {
      const { timerEndsAt } = gameState;
      if (!timerEndsAt) return;
      const delayP = timerEndsAt - Date.now();

      async function skipCurrentTurn() {
        const snap = await get(ref(db, `games/${gameCode}`));
        if (!snap.exists()) return;
        const gs = snap.val() as GameState;
        if (gs.phase !== "playing" || !gs.currentTurnPlayerId) return;
        const lockRef = ref(db, `games/${gameCode}/resolveLock`);
        await runTransaction(lockRef, (current) => {
          const key = "playing_skip_" + gs.currentTurnPlayerId;
          if (current === key) return;
          return key;
        }).then(async (result) => {
          if (!result.committed) return;
          await advanceTurn(gs, gs.currentTurnPlayerId!);
        });
      }

      if (delayP <= 0) {
        skipCurrentTurn();
        return;
      }

      const skipId = setTimeout(skipCurrentTurn, delayP + 200);
      return () => clearTimeout(skipId);
    }

    // Check immediately on state change (covers all-voted case)
    maybeResolve();

    // Also set a timer for the deadline
    const { timerEndsAt } = gameState;
    if (!timerEndsAt) return;
    const delay = timerEndsAt - Date.now();
    if (delay <= 0) { maybeResolve(); return; }
    const id = setTimeout(maybeResolve, delay + 200); // +200ms buffer for clock skew
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState?.phase, gameState?.timerEndsAt,
      JSON.stringify(gameState?.verificationQueue?.[gameState?.currentVerificationIndex ?? 0]?.votes),
      JSON.stringify(gameState?.currentQuestion?.votes),
      JSON.stringify(gameState?.winnerVotes),
      playerId]);

  // ── ACTIONS ───────────────────────────────────────────────────────────────
  async function createGame() {
    if (!playerName.trim()) return setError("Enter your name");
    setLoading(true);
    const code = generateCode();
    const pid  = push(ref(db, "players")).key!;
    const state: GameState = {
      phase: "lobby",
      players: { [pid]: { id: pid, name: playerName.trim(), isHost: true } },
      hostId: pid, verificationQueue: [], currentVerificationIndex: 0,
      turnNumber: 0, winners: [], usedPersons: [], gameCode: code,
    };
    await set(ref(db, `games/${code}`), state);
    setPlayerId(pid); setGameCode(code); setScreen("game");
    showToast("Joined the game!", "success"); setLoading(false);
    showToast("Game created! Share the code.", "success");
  }

  async function joinGame() {
    if (!playerName.trim()) return setError("Enter your name");
    if (!joinCode.trim())   return setError("Enter game code");
    const code = joinCode.toUpperCase();
    const snap = await get(ref(db, `games/${code}`));
    if (!snap.exists()) return setError("Game not found");
    const state = snap.val() as GameState;
    if (state.phase !== "lobby") return setError("Game already started");
    if (Object.keys(state.players || {}).length >= 12) return setError("Game is full (max 12)");
    const pid = push(ref(db, "players")).key!;
    await update(ref(db, `games/${code}/players`), { [pid]: { id: pid, name: playerName.trim(), isHost: false } });
    setPlayerId(pid); setGameCode(code); setScreen("game");
  }

  async function startGame() {
    if (!gameState) return;
    const players = Object.values(gameState.players);
    if (players.length < 2) return setError("Need at least 2 players");
    const usedPersons: string[]                = [];
    const updatedPlayers: Record<string, Player> = {};
    const queue: VerificationRound[]           = [];
    players.forEach((p, i) => {
      const person = pickRandom(FAMOUS_PERSONS, usedPersons);
      usedPersons.push(person);
      updatedPlayers[p.id] = { ...p, assignedPerson: person, turnOrder: i };
      queue.push({ playerId: p.id, playerName: p.name, assignedPerson: person, votes: {} });
    });
    await update(ref(db, `games/${gameCode}`), {
      phase: "verification", players: updatedPlayers,
      verificationQueue: queue, currentVerificationIndex: 0, usedPersons,
      timerEndsAt: Date.now() + TIMER_MS,
    });
    showToast("Game started!", "success");
  }

  async function voteVerification(vote: "yes" | "no") {
    if (!gameState || !playerId) return;
    const idx   = gameState.currentVerificationIndex;
    const round = gameState.verificationQueue[idx];
    if (!round || round.playerId === playerId) return;
    setMyVote(vote);
    await set(ref(db, `games/${gameCode}/verificationQueue/${idx}/votes/${playerId}`), vote);
    showToast(vote === "yes" ? "Voted: Yes, I know them" : "Voted: No idea", "info");
    // Resolution is handled exclusively by the host watcher below — no race.
  }

  async function resolveVerification(gs: GameState) {
    const idx      = gs.currentVerificationIndex;
    const round    = gs.verificationQueue[idx];
    // Use same online-aware eligible count as the host watcher
    const eligible = Object.values(gs.players).filter(
      (p) => !p.isEliminated && p.id !== round.playerId && p.online !== false
    );
    // Fallback: if everyone appears offline, count all non-eliminated
    const eligiblePlayers = eligible.length > 0
      ? eligible
      : Object.values(gs.players).filter((p) => !p.isEliminated && p.id !== round.playerId);
    const yesVotes = Object.values(round.votes || {}).filter((v) => v === "yes").length;
    if (yesVotes <= eligiblePlayers.length / 2) {
      const usedPersons = [...(gs.usedPersons || [])];
      const newPerson   = pickRandom(FAMOUS_PERSONS, usedPersons);
      usedPersons.push(newPerson);
      await update(ref(db, `games/${gameCode}`), {
        [`verificationQueue/${idx}`]: { playerId: round.playerId, playerName: round.playerName, assignedPerson: newPerson, votes: {} },
        [`players/${round.playerId}/assignedPerson`]: newPerson,
        usedPersons,
        timerEndsAt: Date.now() + TIMER_MS,
        resolveLock: null,
      });
    } else {
      const nextIdx = idx + 1;
      if (nextIdx >= gs.verificationQueue.length) {
        const firstPlayer = Object.values(gs.players).find((p) => p.turnOrder === 0)!;
        await update(ref(db, `games/${gameCode}`), {
          phase: "playing", currentTurnPlayerId: firstPlayer.id, turnNumber: 1, currentVerificationIndex: 0,
          timerEndsAt: Date.now() + PLAYING_TIMER_MS,
        });
      } else {
        await update(ref(db, `games/${gameCode}`), { currentVerificationIndex: nextIdx, timerEndsAt: Date.now() + TIMER_MS, resolveLock: null });
      }
    }
  }

  async function submitQuestion(isNameGuess: boolean) {
    if (!gameState || !playerId || !questionText.trim()) return;
    const qid = push(ref(db, "tmp")).key!;
    const q: Question = {
      id: qid, askerId: playerId,
      askerName: gameState.players[playerId]?.name || "",
      text: questionText.trim(), votes: {}, isNameGuess,
    };
    await update(ref(db, `games/${gameCode}`), { phase: "question_voting", currentQuestion: q, timerEndsAt: Date.now() + TIMER_MS });
    setQuestionText("");
    showToast(isNameGuess ? "Name guess submitted!" : "Question submitted!", "success");
  }

  async function voteQuestion(vote: "yes" | "no" | "dont_know") {
    if (!gameState || !playerId) return;
    const q = gameState.currentQuestion;
    if (!q || q.askerId === playerId) return;
    setMyVote(vote);
    await set(ref(db, `games/${gameCode}/currentQuestion/votes/${playerId}`), vote);
    const label = vote === "yes" ? "Yes" : vote === "no" ? "No" : "Don't know";
    showToast(`Voted: ${label}`, "info");
    // Resolution handled exclusively by host watcher — no race.
  }

  async function resolveQuestion(gs: GameState) {
    const q            = gs.currentQuestion!;
    const votes        = q.votes;
    const totalVoters  = Object.values(gs.players).filter((p) => !p.isEliminated && p.id !== q.askerId).length;
    const dontKnowCnt  = Object.values(votes).filter((v) => v === "dont_know").length;
    if (dontKnowCnt > totalVoters / 2 && !q.isNameGuess) {
      await update(ref(db, `games/${gameCode}`), { phase: "playing", currentQuestion: null });
      return;
    }
    if (q.isNameGuess) {
      const yesCount = Object.values(votes).filter((v) => v === "yes").length;
      if (yesCount > totalVoters / 2) {
        const winners        = [...(gs.winners || []), q.askerId];
        const updatedPlayers = { ...gs.players };
        updatedPlayers[q.askerId] = { ...updatedPlayers[q.askerId], isWinner: true };
        if (winners.length >= 3) {
          updatedPlayers[winners[0]] = { ...updatedPlayers[winners[0]], isEliminated: true };
          await update(ref(db, `games/${gameCode}`), { players: updatedPlayers, winners: winners.slice(1) });
          await advanceTurn(gs, q.askerId);
        } else {
          await update(ref(db, `games/${gameCode}`), { players: updatedPlayers, winners });
          const remaining = Object.values(updatedPlayers).filter((p) => !p.isWinner && !p.isEliminated);
          if (remaining.length <= 1) {
            await update(ref(db, `games/${gameCode}`), { phase: "ended", currentQuestion: null });
            return;
          }
          await advanceTurn(gs, q.askerId);
        }
        return;
      }
    }
    await update(ref(db, `games/${gameCode}`), { phase: "results_shown" });
  }

  async function advanceTurn(gs: GameState, currentPlayerId: string) {
    const players = Object.values(gs.players)
      .filter((p) => !p.isWinner && !p.isEliminated)
      .sort((a, b) => (a.turnOrder ?? 0) - (b.turnOrder ?? 0));
    if (players.length === 0) {
      await update(ref(db, `games/${gameCode}`), { phase: "ended", currentQuestion: null });
      return;
    }
    const curIdx        = players.findIndex((p) => p.id === currentPlayerId);
    const nextPlayer    = players[(curIdx + 1) % players.length];
    const newTurnNumber = (gs.turnNumber || 0) + 1;
    const phase         = newTurnNumber > 0 && newTurnNumber % 10 === 0 ? "winner_check" : "playing";
    await update(ref(db, `games/${gameCode}`), {
      phase, currentTurnPlayerId: nextPlayer.id, turnNumber: newTurnNumber, currentQuestion: null,
      timerEndsAt: phase === "winner_check"
        ? Date.now() + TIMER_MS
        : Date.now() + PLAYING_TIMER_MS,
    });
  }

  async function acknowledgeResults() {
    if (!gameState) return;
    await advanceTurn(gameState, gameState.currentTurnPlayerId!);
    showToast("Next turn!", "info");
  }

  async function voteWinnerCheck(vote: string) {
    if (!gameState || !playerId) return;
    setMyVote(vote);
    await set(ref(db, `games/${gameCode}/winnerVotes/${playerId}`), vote);
    showToast(vote === "none" ? "Voted: No winner yet" : "Voted for a winner", "info");
    // Resolution handled exclusively by host watcher — no race.
  }

  async function resolveWinnerCheck(gs: GameState) {
    const votes     = gs.winnerVotes || {};
    const values    = Object.values(votes);
    const total     = values.length;
    const tallyMap: Record<string, number> = {};
    values.forEach((v) => { if (v !== "none") tallyMap[v] = (tallyMap[v] || 0) + 1; });
    const noMajority = values.filter((v) => v === "none").length > total / 2;
    if (noMajority) {
      await update(ref(db, `games/${gameCode}`), {
        phase: "playing", winnerVotes: null,
        timerEndsAt: Date.now() + PLAYING_TIMER_MS,
        resolveLock: null,
      });
      return;
    }
    const winner = Object.entries(tallyMap).find(([, cnt]) => cnt > total / 2);
    if (winner) {
      const winnerId       = winner[0];
      const updatedPlayers = { ...gs.players };
      updatedPlayers[winnerId] = { ...updatedPlayers[winnerId], isWinner: true };
      const winners = [...(gs.winners || []), winnerId];
      if (winners.length >= 3) {
        updatedPlayers[winners[0]] = { ...updatedPlayers[winners[0]], isEliminated: true };
        await update(ref(db, `games/${gameCode}`), {
          players: updatedPlayers, winners: winners.slice(1),
          phase: "playing", winnerVotes: null,
          timerEndsAt: Date.now() + PLAYING_TIMER_MS,
          resolveLock: null,
        });
      } else {
        await update(ref(db, `games/${gameCode}`), {
          players: updatedPlayers, winners,
          phase: "playing", winnerVotes: null,
          timerEndsAt: Date.now() + PLAYING_TIMER_MS,
          resolveLock: null,
        });
      }
      if (Object.values(updatedPlayers).filter((p) => !p.isWinner && !p.isEliminated).length <= 1)
        await update(ref(db, `games/${gameCode}`), { phase: "ended" });
    } else {
      await update(ref(db, `games/${gameCode}`), {
        phase: "playing", winnerVotes: null,
        timerEndsAt: Date.now() + PLAYING_TIMER_MS,
        resolveLock: null,
      });
    }
  }

  // ── SCREENS ───────────────────────────────────────────────────────────────

  // HOME
  if (screen === "home") {
    return (
      <PageShell eyebrow="Welcome to" title="Who Am I?">
        <Panel>
          <Row first>
            <Input value={playerName} onChange={(v) => { setPlayerName(v); setError(""); }}
              placeholder="Enter your name..." label="Your name" maxLength={20} />
          </Row>
          <Row>
            <Btn onClick={createGame} disabled={loading} style={{ width: "100%" }}>
              {loading ? "Creating..." : "Create new game"}
            </Btn>
          </Row>
          <Row>
            <div style={{ display: "flex", gap: 8 }}>
              <Input value={joinCode} onChange={(v) => { setJoinCode(v); setError(""); }}
                label="Game code" maxLength={5}
                style={{ flex: 1 }} inputStyle={{ textTransform: "uppercase" }} />
              <Btn onClick={joinGame} style={{ flexShrink: 0 }}>Join</Btn>
            </div>
          </Row>
          {error && <Row><Alert type="warn">{error}</Alert></Row>}
        </Panel>
      </PageShell>
    );
  }

  if (!gameState || !playerId) {
    return (
      <div style={{
        minHeight: "100vh", background: T.bg,
        display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT,
      }}>
        <span style={{ color: T.textMuted, fontSize: 14 }}>Connecting...</span>
      </div>
    );
  }

  const me            = gameState.players[playerId];
  const allPlayers    = Object.values(gameState.players);
  const activePlayers = allPlayers.filter((p) => !p.isEliminated);
  const isHost        = gameState.hostId === playerId;
  const isMyTurn      = gameState.currentTurnPlayerId === playerId;
  const myPerson      = me?.assignedPerson;

  // FloatingBar is always rendered — it's position:fixed so it overlays every screen
  const floatingBar = (
    <FloatingBar
      gameCode={gameCode}
      playerId={playerId}
      playerName={me?.name ?? playerName}
    />
  );

  function PlayerList() {
    return (
      <>
        {allPlayers.map((p) => (
          <PlayerRow
            key={p.id}
            p={p}
            isCurrent={gameState!.currentTurnPlayerId === p.id}
            isMe={p.id === playerId}
          />
        ))}
      </>
    );
  }

  // LOBBY
  if (gameState.phase === "lobby") {
    return (<>{floatingBar}
      <PageShell eyebrow="Stiff Socks × BradyYourTutor" title="Guess Your Person">
        <Panel>
          <Row first>
            <Label>Game Code</Label>
            <div style={{
              fontSize: 40, fontWeight: 800, letterSpacing: "0.22em",
              color: "#ffffff", textAlign: "center", padding: "6px 0",
              fontFamily: FONT,
            }}>
              {gameCode}
            </div>
            <div style={{
              textAlign: "center", fontSize: 16, color: T.textMuted, marginTop: 4, fontFamily: FONT,
            }}>
              Share this code — up to 12 players
            </div>
          </Row>
          <Row>
            <Label>Players ({allPlayers.length} / 12)</Label>
          </Row>
          <PlayerList />
          <Row>
            {isHost
              ? allPlayers.length < 2
                ? <Alert type="warn">Waiting for at least 2 players to join...</Alert>
                : <Btn onClick={startGame} style={{ width: "100%" }}>
                    Start game — {allPlayers.length} players
                  </Btn>
              : <Alert type="info">Waiting for the host to start...</Alert>
            }
          </Row>
        </Panel>
      </PageShell>
    </>
    );
  }

  // VERIFICATION
  if (gameState.phase === "verification") {
    const idx           = gameState.currentVerificationIndex;
    const round         = gameState.verificationQueue?.[idx];
    if (!round) return null;
    const isMyRound     = round.playerId === playerId;
    const currentMyVote = myVote || round.votes?.[playerId];
    const votesCast     = Object.keys(round.votes || {}).length;
    const eligibleCount = allPlayers.length - 1;

    return (<>{floatingBar}
      <PageShell
        eyebrow={`Verification ${idx + 1} / ${gameState.verificationQueue.length}`}
        title="Does everyone know this person?"
      >
        <Panel>
          <Row first>
            <Label>{round.playerName}'s assigned person</Label>
            {isMyRound ? (
              <div style={{ fontSize: 22, fontWeight: 700, color: T.textMuted, fontFamily: FONT, fontStyle: "italic" }}>
                (hidden from you)
              </div>
            ) : (
              <div style={{
                fontSize: 26, fontWeight: 800, color: T.textPrimary,
                letterSpacing: "-0.03em", marginBottom: 4, fontFamily: FONT,
              }}>
                {round.assignedPerson}
              </div>
            )}
            <div style={{ fontSize: 16, color: T.textMuted, fontFamily: FONT }}>
              Majority must know this person for the round to proceed
            </div>
          </Row>

          {isMyRound ? (
            <Row>
              <Alert type="info">This is your person — wait while others confirm they know who this is.</Alert>
            </Row>
          ) : (
            <Row>
              <Label>Do you know this person?</Label>
              <div style={{ display: "flex", gap: 8 }}>
                <VoteBtn label="Yes, I know them"
                  active={currentMyVote === "yes"} color={T.green} bgColor={T.greenDim}
                  onClick={() => !currentMyVote && voteVerification("yes")} disabled={!!currentMyVote} />
                <VoteBtn label="No idea"
                  active={currentMyVote === "no"} color={T.red} bgColor={T.redDim}
                  onClick={() => !currentMyVote && voteVerification("no")} disabled={!!currentMyVote} />
              </div>
              {currentMyVote && (
                <div style={{ marginTop: 10 }}>
                  <Alert type="info">Voted — waiting for others ({votesCast} / {eligibleCount})</Alert>
                </div>
              )}
            </Row>
          )}

          <Row>
            <Timer
              endsAt={gameState.timerEndsAt ?? Date.now()}
              totalMs={TIMER_MS}
              onExpire={undefined}
            />
          </Row>
          <Row><Label>Players</Label></Row>
          <PlayerList />
          <div style={{ height: 2 }} />
        </Panel>
      </PageShell>
    </>
    );
  }

  // PLAYING
  if (gameState.phase === "playing") {
    const currentPlayer = gameState.players[gameState.currentTurnPlayerId || ""];
    const amWinner      = me?.isWinner;
    return (<>{floatingBar}
      <PageShell
        eyebrow={`Turn ${gameState.turnNumber}`}
        title={isMyTurn ? "Your turn" : `${currentPlayer?.name}'s turn`}
      >
        <Panel>
          {/* Show the CURRENT PLAYER'S person to everyone except that player.
              Nobody ever sees their own person — that's the point of the game. */}
          {currentPlayer?.assignedPerson && !isMyTurn && (
            <Row first>
              <Label>{currentPlayer.name}'s person — help them guess!</Label>
              <div style={{
                fontSize: 22, fontWeight: 800, color: "#ffffff",
                letterSpacing: "-0.02em", fontFamily: FONT,
              }}>
                {currentPlayer.assignedPerson}
              </div>
              <div style={{ fontSize: 16, color: T.textMuted, marginTop: 4, fontFamily: FONT }}>
                They don't know who they are — answer their yes/no questions
              </div>
            </Row>
          )}

          {isMyTurn && !amWinner ? (
            <Row first={!myPerson}>
              <Label>Ask a yes / no question</Label>
              <PersonSuggest
                value={questionText}
                onChange={setQuestionText}
                placeholder="e.g. Am I an actor? Am I American? Am I still alive?"
                persons={FAMOUS_PERSONS}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <Btn onClick={() => submitQuestion(false)} disabled={!questionText.trim()} style={{ flex: 1 }}>
                  Ask question
                </Btn>
                <Btn onClick={() => submitQuestion(true)} disabled={!questionText.trim()} variant="ghost" style={{ flex: 1 }}>
                  🎯 Name guess
                </Btn>
              </div>
              <div style={{ fontSize: 15, color: T.textMuted, marginTop: 8, fontFamily: FONT }}>
                Use "Name guess" when you think you know who you are, e.g. "Am I Elon Musk?"
              </div>
            </Row>
          ) : (
            <Row first={!myPerson}>
              {amWinner
                ? <Alert type="success">You've won — you can still vote on others' questions.</Alert>
                : <Alert type="info">Waiting for {currentPlayer?.name} to ask a question...</Alert>
              }
            </Row>
          )}

          <Row>
            <Timer
              endsAt={gameState.timerEndsAt ?? Date.now()}
              totalMs={PLAYING_TIMER_MS}
              onExpire={undefined}
            />
          </Row>
          <Row><Label>Players</Label></Row>
          <PlayerList />
          <div style={{ height: 2 }} />
        </Panel>
      </PageShell>
    </>
    );
  }

  // QUESTION VOTING
  if (gameState.phase === "question_voting") {
    const q             = gameState.currentQuestion;
    if (!q) return null;
    const isAsker       = q.askerId === playerId;
    const totalVoters   = activePlayers.filter((p) => p.id !== q.askerId).length;
    const votesIn       = Object.keys(q.votes || {}).length;
    const currentMyVote = myVote || q.votes?.[playerId];

    return (<>{floatingBar}
      <PageShell eyebrow={`${gameState.players[q.askerId]?.name} asks`} title="Answer the question">
        <Panel>
          <Row first>
            {q.isNameGuess && (
              <div style={{
                fontSize: 10, fontWeight: 700, color: T.amber,
                letterSpacing: "0.15em", textTransform: "uppercase" as const,
                marginBottom: 8, fontFamily: FONT,
              }}>
                Name Guess
              </div>
            )}
            <div style={{
              fontSize: 20, fontWeight: 700, color: T.textPrimary,
              lineHeight: 1.45, fontFamily: FONT, letterSpacing: "-0.02em",
            }}>
              "{q.text}"
            </div>
            <div style={{ fontSize: 15, color: T.textMuted, marginTop: 6, fontFamily: FONT }}>
              asked by {gameState.players[q.askerId]?.name}
            </div>
          </Row>

          {!isAsker ? (
            <Row>
              <Label>Your answer</Label>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <VoteBtn label="✓  Yes"
                    active={currentMyVote === "yes"} color={T.green} bgColor={T.greenDim}
                    onClick={() => !currentMyVote && voteQuestion("yes")} disabled={!!currentMyVote} />
                  <VoteBtn label="✗  No"
                    active={currentMyVote === "no"} color={T.red} bgColor={T.redDim}
                    onClick={() => !currentMyVote && voteQuestion("no")} disabled={!!currentMyVote} />
                </div>
                {!q.isNameGuess && (
                  <VoteBtn label="?  Don't know"
                    active={currentMyVote === "dont_know"} color={T.amber} bgColor={T.amberDim}
                    onClick={() => !currentMyVote && voteQuestion("dont_know")} disabled={!!currentMyVote} />
                )}
              </div>
              {currentMyVote && (
                <div style={{ marginTop: 10 }}>
                  <Alert type="info">Submitted — waiting for others ({votesIn} / {totalVoters})</Alert>
                </div>
              )}
            </Row>
          ) : (
            <Row>
              <Alert type="info">Waiting for others to answer... ({votesIn} / {totalVoters})</Alert>
            </Row>
          )}

          {/* Show the ASKER'S person to everyone else so they can answer accurately.
              The asker themselves never sees it. */}
          {!isAsker && gameState.players[q.askerId]?.assignedPerson && (
            <Row>
              <Label>{gameState.players[q.askerId]?.name}'s person</Label>
              <div style={{
                fontSize: 20, fontWeight: 800, color: "#ffffff",
                letterSpacing: "-0.02em", fontFamily: FONT,
              }}>
                {gameState.players[q.askerId]?.assignedPerson}
              </div>
              <div style={{ fontSize: 15, color: T.textMuted, marginTop: 4, fontFamily: FONT }}>
                Answer based on this person
              </div>
            </Row>
          )}

          <Row>
            <Timer
              endsAt={gameState.timerEndsAt ?? Date.now()}
              totalMs={TIMER_MS}
              onExpire={undefined}
            />
          </Row>
          <Row><Label>Players</Label></Row>
          <PlayerList />
          <div style={{ height: 2 }} />
        </Panel>
      </PageShell>
    </>
    );
  }

  // RESULTS
  if (gameState.phase === "results_shown") {
    const q        = gameState.currentQuestion;
    if (!q) return null;
    const votes    = q.votes || {};
    const isAsker  = q.askerId === playerId;
    const yesCount = Object.values(votes).filter((v) => v === "yes").length;
    const noCount  = Object.values(votes).filter((v) => v === "no").length;
    const dkCount  = Object.values(votes).filter((v) => v === "dont_know").length;
    const total    = Object.values(votes).length;

    return (<>{floatingBar}
      <PageShell eyebrow="Results" title="The votes are in">
        <Panel>
          <Row first>
            <div style={{ fontSize: 16, color: T.textMuted, marginBottom: 18, fontFamily: FONT }}>
              "{q.text}"
            </div>
            {[
              { label: "Yes",        count: yesCount, color: T.green },
              { label: "No",         count: noCount,  color: T.red   },
              { label: "Don't know", count: dkCount,  color: T.amber },
            ].map(({ label, count, color }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <div style={{ width: 82, fontSize: 15, color: T.textSecond, fontFamily: FONT }}>{label}</div>
                <div style={{ flex: 1, height: 4, background: "#141414", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{
                    width: `${total > 0 ? (count / total) * 100 : 0}%`,
                    height: "100%", background: color, borderRadius: 99,
                    transition: "width 0.5s ease", minWidth: count > 0 ? 4 : 0,
                  }} />
                </div>
                <div style={{ width: 18, textAlign: "right" as const, fontSize: 15, color: T.textSecond, fontFamily: FONT }}>
                  {count}
                </div>
              </div>
            ))}
            {isAsker ? (
              <Btn onClick={acknowledgeResults} style={{ width: "100%", marginTop: 14 }}>Next turn →</Btn>
            ) : (
              <div style={{ marginTop: 14 }}>
                <Alert type="info">Waiting for {gameState.players[q.askerId]?.name} to continue...</Alert>
              </div>
            )}
          </Row>
          <Row><Label>Players</Label></Row>
          <PlayerList />
          <div style={{ height: 2 }} />
        </Panel>
      </PageShell>
    </>
    );
  }

  // WINNER CHECK
  if (gameState.phase === "winner_check") {
    const myVoteWC  = myVote || (gameState.winnerVotes || {})[playerId];
    const votesIn   = Object.keys(gameState.winnerVotes || {}).length;
    const candidates = activePlayers.filter((p) => !p.isWinner);

    return (<>{floatingBar}
      <PageShell eyebrow="Every 10 turns" title="Has anyone won?">
        <Panel>
          <Row first>
            <Label>Vote for a winner</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {candidates.map((p) => (
                <VoteBtn key={p.id} label={`${p.name} guessed their person`}
                  active={myVoteWC === p.id} color={"#ffffff"} bgColor={"#1a1a1a"}
                  onClick={() => !myVoteWC && voteWinnerCheck(p.id)} disabled={!!myVoteWC} />
              ))}
              <VoteBtn label="No — nobody has won yet"
                active={myVoteWC === "none"} color={T.textMuted} bgColor="#111"
                onClick={() => !myVoteWC && voteWinnerCheck("none")} disabled={!!myVoteWC} />
            </div>
            {myVoteWC && (
              <div style={{ marginTop: 10 }}>
                <Alert type="info">Voted! ({votesIn} / {activePlayers.length})</Alert>
              </div>
            )}
          </Row>
          <Row>
            <Timer
              endsAt={gameState.timerEndsAt ?? Date.now()}
              totalMs={TIMER_MS}
              onExpire={undefined}
            />
          </Row>
          <Row><Label>Players</Label></Row>
          <PlayerList />
          <div style={{ height: 2 }} />
        </Panel>
      </PageShell>
    </>
    );
  }

  // ENDED
  if (gameState.phase === "ended") {
    const winners  = (gameState.winners || []).map((id) => gameState.players[id]).filter(Boolean);
    const amWinner = gameState.winners?.includes(playerId);

    return (<>{floatingBar}
      <PageShell eyebrow="Game over" title="Winner!">
        <Panel>
          {winners.map((w, i) => (
            <Row key={w?.id} first={i === 0}>
              <div style={{ textAlign: "center", padding: "6px 0" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>👑</div>
                <div style={{
                  fontSize: 26, fontWeight: 800, color: T.textPrimary,
                  letterSpacing: "-0.03em", fontFamily: FONT,
                }}>
                  {w?.name}
                </div>
                <div style={{
                  fontSize: 14, color: T.textMuted, marginTop: 5,
                  textTransform: "uppercase" as const, letterSpacing: "0.15em", fontFamily: FONT,
                }}>
                  Winner
                </div>
              </div>
            </Row>
          ))}

          {amWinner && (
            <Row><Alert type="success">🎉 Congratulations, you won!</Alert></Row>
          )}

          <Row>
            <Label>All players & their persons</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {allPlayers.map((p) => (
                <div key={p.id} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "9px 13px", borderRadius: 8,
                  background: "#0a0a0a", border: `1px solid ${T.border}`,
                }}>
                  <span style={{ fontSize: 14, color: T.textPrimary, fontFamily: FONT }}>
                    {p.name}{p.isWinner ? " 👑" : ""}
                  </span>
                  <span style={{ fontSize: 15, color: T.textMuted, fontFamily: FONT }}>
                    {p.assignedPerson}
                  </span>
                </div>
              ))}
            </div>
          </Row>

          <Row>
            <Btn style={{ width: "100%" }} onClick={() => {
              setScreen("home"); setGameCode(""); setPlayerId(null); setGameState(null);
            }}>
              Back to home
            </Btn>
          </Row>
        </Panel>
      </PageShell>
    </>
    );
  }

  return null;
}
