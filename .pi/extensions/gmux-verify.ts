/**
 * gmux_verify — browser verification tool for james-gmux development.
 *
 * Discovers running daemon instances by enumerating unix sockets under
 * ~/.local/state and querying /v1/health on each. Derives port, token,
 * dev-proxy URL, and instance identity from the daemon's topology block
 * rather than from hardcoded constants.
 *
 * Three scenarios:
 *   frontend — prod daemon (gmux) + vite (:16134). Use for UI/CSS changes.
 *   full     — dev daemon whose started_in matches repoRoot + its vite.
 *              Use when any .go file changed.
 *   prod     — prod daemon (gmux), no vite. Reproduce bugs or verify
 *              after `moon run :install`.
 */

import { execSync, execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, appendFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── scenario config ─────────────────────────────────────────────────────────
// The only hardcoded values are the prod instance name and the frontend vite
// port (launched by this tool with an explicit --port). Everything else comes
// from the daemon's topology block.

const PROD_INSTANCE = "gmux";
const FRONTEND_VITE_PORT = 16134;

const SCENARIOS = {
	frontend: {
		instanceName: PROD_INSTANCE,
		vitePort: FRONTEND_VITE_PORT,
		startViteCmd: "./node_modules/.bin/moon run gmux-web:serve" as string | null,
		startDaemonCmd: null as string | null,
		daemonTimeoutMs: 20_000,
	},
	full: {
		instanceName: null as string | null, // matched by started_in
		vitePort: null as number | null,     // from topology.dev_proxy
		startViteCmd: null as string | null, // vite started by moon run gmuxd:dev
		startDaemonCmd: "./node_modules/.bin/moon run gmuxd:dev" as string | null,
		daemonTimeoutMs: 60_000,             // includes Go build time
	},
	prod: {
		instanceName: PROD_INSTANCE,
		vitePort: null as number | null,
		startViteCmd: null as string | null,
		startDaemonCmd: null as string | null,
		daemonTimeoutMs: 0,
	},
} as const;

type Scenario = keyof typeof SCENARIOS;

// ── types ───────────────────────────────────────────────────────────────────

interface TopologyBlock {
	instance: string;
	listen_port: number;
	dev_proxy?: string;
	state_dir: string;
	started_in: string;
	vcs: { revision: string; modified: boolean; time?: string };
}

interface DiscoveredInstance {
	socketPath: string;
	listenPort: number;
	authToken: string;
	topology: TopologyBlock;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function sh(cmd: string): string {
	return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
}

function logFile(instance: string): string {
	return join(tmpdir(), `gmux-verify-${instance}.log`);
}

function spawnBackground(cmd: string, cwd: string, instance: string): void {
	const log = logFile(instance);
	const out = require("node:fs").openSync(log, "a");
	const proc = spawn("bash", ["-c", cmd], {
		cwd,
		detached: true,
		stdio: ["ignore", out, out],
	});
	proc.unref();
}

function tailLog(instance: string, lines = 30): string {
	const log = logFile(instance);
	try {
		return execSync(`tail -n ${lines} ${log}`, { encoding: "utf-8", stdio: "pipe" });
	} catch {
		return "(no log output)";
	}
}

async function pollUntil(
	check: () => boolean,
	timeoutMs: number,
	intervalMs = 500,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await sleep(intervalMs);
	}
	return false;
}

// ── socket discovery ────────────────────────────────────────────────────────

/** Candidate socket paths under a state root directory. */
function socketCandidates(stateRoot: string): string[] {
	const candidates: string[] = [];
	let dirs: string[];
	try {
		dirs = readdirSync(stateRoot);
	} catch {
		return candidates;
	}
	for (const d of dirs) {
		const base = join(stateRoot, d);
		// Prod layout: ~/.local/state/gmux/gmuxd.sock
		candidates.push(join(base, "gmuxd.sock"));
		// Dev layout: ~/.local/state/gmux-dev[-xxx]/state/gmux/gmuxd.sock
		candidates.push(join(base, "state", "gmux", "gmuxd.sock"));
	}
	return candidates;
}

/** Query /v1/health over a unix socket. Returns parsed data or null. */
function querySocket(sockPath: string): { auth_token?: string; topology?: TopologyBlock } | null {
	if (!existsSync(sockPath)) return null;
	try {
		const raw = execFileSync(
			"curl",
			["--silent", "--unix-socket", sockPath, "http://localhost/v1/health"],
			{ timeout: 3000, stdio: "pipe", encoding: "utf-8" },
		);
		const body = JSON.parse(raw);
		if (!body.ok) return null;
		return body.data as { auth_token?: string; topology?: TopologyBlock };
	} catch {
		return null;
	}
}

/** Enumerate all live daemon instances reachable via unix sockets. */
function discoverInstances(): DiscoveredInstance[] {
	const stateRoot = join(homedir(), ".local", "state");
	const instances: DiscoveredInstance[] = [];
	for (const sockPath of socketCandidates(stateRoot)) {
		const data = querySocket(sockPath);
		if (!data?.topology || !data.auth_token) continue;
		instances.push({
			socketPath: sockPath,
			listenPort: data.topology.listen_port,
			authToken: data.auth_token,
			topology: data.topology,
		});
	}
	return instances;
}

/** Select the right instance for the requested scenario. */
function selectInstance(
	instances: DiscoveredInstance[],
	scenario: Scenario,
	repoRoot: string,
): DiscoveredInstance | null {
	if (scenario === "full") {
		// Match by started_in so worktree instances are found without port arithmetic.
		// The daemon may be started from a subdirectory (e.g. services/gmuxd), so
		// check if started_in equals repoRoot or lives under it.
		return instances.find((i) =>
			i.topology.started_in === repoRoot ||
			i.topology.started_in.startsWith(repoRoot + "/")
		) ?? null;
	}
	// frontend + prod: prod daemon
	return instances.find((i) => i.topology.instance === PROD_INSTANCE) ?? null;
}

// ── vite health ─────────────────────────────────────────────────────────────

function isViteUp(port: number): boolean {
	try {
		execSync(`curl -sf http://localhost:${port} -o /dev/null`, {
			timeout: 2000,
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

/** Parse port from a URL like "http://localhost:5173". */
function portFromUrl(url: string): number | null {
	try {
		const u = new URL(url);
		const p = parseInt(u.port, 10);
		return isNaN(p) ? null : p;
	} catch {
		return null;
	}
}

// ── slug lookup ─────────────────────────────────────────────────────────────

interface ProjectsState {
	version: number;
	items: Array<{
		slug: string;
		match: Array<{ path?: string; remote?: string; exact?: boolean }>;
	}>;
}

function findSlug(stateDir: string, repoRoot: string): string {
	let state: ProjectsState;
	try {
		state = JSON.parse(readFileSync(join(stateDir, "projects.json"), "utf-8"));
	} catch {
		return "";
	}

	let bestSlug = "";
	let bestLen = 0;

	for (const item of state.items) {
		for (const rule of item.match) {
			if (!rule.path) continue;
			const norm = rule.path.startsWith("~")
				? homedir() + rule.path.slice(1)
				: rule.path;
			if (rule.exact) {
				if (repoRoot === norm && norm.length > bestLen) {
					bestSlug = item.slug;
					bestLen = norm.length;
				}
			} else {
				if (
					(repoRoot === norm || repoRoot.startsWith(norm + "/")) &&
					norm.length > bestLen
				) {
					bestSlug = item.slug;
					bestLen = norm.length;
				}
			}
		}
	}
	return bestSlug;
}

// ── staleness guard ─────────────────────────────────────────────────────────

/** Returns true if there are uncommitted .go changes in repoRoot. */
function hasGoDirt(repoRoot: string): boolean {
	try {
		const out = execSync("git status --porcelain -- '*.go'", {
			cwd: repoRoot,
			encoding: "utf-8",
			stdio: "pipe",
		}).trim();
		return out.length > 0;
	} catch {
		return false;
	}
}

/** Returns the HEAD commit SHA. */
function localHead(repoRoot: string): string {
	try {
		return sh(`git -C "${repoRoot}" rev-parse HEAD`);
	} catch {
		return "";
	}
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "gmux_verify",
		label: "gmux verify",
		description: [
			"Open a james-gmux app route in the browser for the given dev scenario.",
			"Discovers daemon instances via unix sockets — no hardcoded ports.",
			`Scenarios: 'frontend' (UI/CSS — prod daemon + vite :${FRONTEND_VITE_PORT}),`,
			"'full' (Go changed — dev daemon matched by repo path + its vite URL),",
			"'prod' (bug repro or post-install verify — prod daemon only).",
			"route is the path after the slug, e.g. 'sessions' or '' for the project home.",
			"After navigating, two window helpers are available via agent-browser eval:",
			"  window.__gmuxLaunchPiSdk(cwd) — POST /v1/launch; returns {data:{session_id}, ok}.",
			"  window.__gmuxSendMessage(text) — send a message to the open pi-sdk session.",
		].join(" "),
		promptGuidelines: [
			"Always use gmux_verify instead of manually constructing TOKEN= commands or agent-browser navigate calls.",
			`frontend: UI/React/CSS only, no Go changes. full: any .go file changed. prod: reproduce a bug or verify after moon run :install.`,
			"To test a pi-sdk session: call gmux_verify to authenticate, then use agent-browser eval with __gmuxLaunchPiSdk and __gmuxSendMessage.",
		],
		parameters: Type.Object({
			scenario: Type.Union(
				[
					Type.Literal("frontend"),
					Type.Literal("full"),
					Type.Literal("prod"),
				],
				{ description: "Which dev environment to use" },
			),
			route: Type.String({
				description:
					"Path after the project slug, e.g. 'sessions' or '' for the project home. No leading slash needed.",
			}),
			screenshotPath: Type.Optional(
				Type.String({
					description:
						"Absolute path to save a PNG screenshot after navigating. Omit to use a temp path.",
				}),
			),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cfg = SCENARIOS[params.scenario as Scenario];
			const repoRoot = ctx.cwd;
			const lines: string[] = [];
			const ok = (msg: string) => lines.push(`✓ ${msg}`);
			const info = (msg: string) => lines.push(`  ${msg}`);
			const fail = (msg: string) => ({
				content: [
					{ type: "text" as const, text: [...lines, `✗ ${msg}`].join("\n") },
				],
				details: {},
				isError: true,
			});

			// ── Staleness guard (frontend scenario) ───────────────────────────────
			if (params.scenario === "frontend" && hasGoDirt(repoRoot)) {
				return fail(
					"Uncommitted .go changes detected. Use scenario 'full' to verify Go changes — " +
						"'frontend' only covers UI/CSS. Run `git stash` if these changes are unrelated.",
				);
			}

			// ── 1. Discover daemon instance ────────────────────────────────────────

			const allInstances = discoverInstances();
			let instance = selectInstance(allInstances, params.scenario as Scenario, repoRoot);

			if (!instance) {
				if (!cfg.startDaemonCmd) {
					return fail(
						params.scenario === "prod" || params.scenario === "frontend"
							? `Prod daemon ('${PROD_INSTANCE}') is not running. ` +
									"It should already be running — run `gmuxd status` to check."
							: `No dev daemon instance found whose started_in matches '${repoRoot}'. ` +
									"Is the daemon running? Check `moon run gmuxd:dev`.",
					);
				}

				const logTag = params.scenario;
				info(`Daemon not running. Starting: ${cfg.startDaemonCmd}`);
				spawnBackground(cfg.startDaemonCmd, repoRoot, logTag);
				info(`Waiting for daemon to start (up to ${cfg.daemonTimeoutMs / 1000}s)…`);

				const started = await pollUntil(() => {
					const fresh = discoverInstances();
					instance = selectInstance(fresh, params.scenario as Scenario, repoRoot);
					return instance != null;
				}, cfg.daemonTimeoutMs);

				if (!started || !instance) {
					const tail = tailLog(logTag);
					return fail(
						`Daemon did not start within ${cfg.daemonTimeoutMs / 1000}s.\n` +
							`Log (${logFile(logTag)}):\n${tail}`,
					);
				}
				ok(`Daemon started (instance: ${instance.topology.instance}, port: ${instance.listenPort})`);
			} else {
				ok(`Daemon up (instance: ${instance.topology.instance}, port: ${instance.listenPort})`);
			}

			// ── 1b. Staleness guard (full scenario) ────────────────────────────────
			if (params.scenario === "full") {
				const head = localHead(repoRoot);
				const daemonRev = instance.topology.vcs?.revision ?? "";
				if (head && daemonRev && head !== daemonRev) {
					info(
						`Staleness: daemon on ${daemonRev.slice(0, 7)}, HEAD is ${head.slice(0, 7)}. ` +
							"Waiting up to 30s for watchexec rebuild…",
					);
					const synced = await pollUntil(() => {
						const fresh = discoverInstances();
						const fi = selectInstance(fresh, "full", repoRoot);
						if (fi?.topology.vcs?.revision === head) {
							instance = fi;
							return true;
						}
						return false;
					}, 30_000);
					if (!synced) {
						return fail(
							`Daemon revision ${daemonRev.slice(0, 7)} still doesn't match HEAD ${head.slice(0, 7)} after 30s. ` +
								"Run `moon run gmuxd:dev` manually to see the build error.",
						);
					}
					ok(`Daemon rebuilt to ${head.slice(0, 7)}`);
				}
			}

			// ── 2. Vite (frontend + full only) ────────────────────────────────────

			let appPort: number;
			let baseUrl: string;

			if (params.scenario === "prod") {
				appPort = instance.listenPort;
				baseUrl = `http://localhost:${appPort}`;
			} else if (params.scenario === "frontend") {
				appPort = FRONTEND_VITE_PORT;
				baseUrl = `http://localhost:${appPort}`;
				if (!isViteUp(appPort)) {
					info(`Vite not running on :${appPort}. Starting…`);
					spawnBackground(cfg.startViteCmd!, repoRoot, "frontend-vite");
					info("Waiting for vite (up to 30s)…");
					const viteReady = await pollUntil(() => isViteUp(appPort), 30_000);
					if (!viteReady) {
						return fail(
							`Vite did not come up on :${appPort} within 30s.\n` +
								`Log: ${tailLog("frontend-vite")}`,
						);
					}
					ok(`Vite up on :${appPort}`);
				} else {
					ok(`Vite up on :${appPort}`);
				}
			} else {
				// full — vite URL from daemon topology
				const devProxy = instance.topology.dev_proxy ?? "";
				const devPort = portFromUrl(devProxy);
				if (!devPort) {
					return fail(
						`Dev daemon topology.dev_proxy is '${devProxy}' — cannot determine vite port. ` +
							"Is the daemon running with GMUXD_DEV_PROXY set?",
					);
				}
				appPort = devPort;
				baseUrl = `http://localhost:${appPort}`;

				if (!isViteUp(appPort)) {
					// Daemon is up but vite is down — self-heal by starting vite directly.
					info(`Dev daemon up but vite down on :${appPort}. Self-healing…`);
					const healCmd = `VITE_DEV_PROXY_PORT=${instance.listenPort} ./node_modules/.bin/moon run gmux-web:serve`;
					spawnBackground(healCmd, repoRoot, "full-vite");
					info("Waiting for vite (up to 30s)…");
					const viteReady = await pollUntil(() => isViteUp(appPort), 30_000);
					if (!viteReady) {
						return fail(
							`Vite did not come up on :${appPort} within 30s.\n` +
								`Log: ${tailLog("full-vite")}`,
						);
					}
					ok(`Vite self-healed on :${appPort}`);
				} else {
					ok(`Vite up on :${appPort}`);
				}
			}

			// ── 3. Token + slug ───────────────────────────────────────────────────

			const token = instance.authToken;
			ok("Token obtained from daemon");

			const slug = findSlug(instance.topology.state_dir, repoRoot);
			if (!slug) {
				return fail(
					`No project matching path '${repoRoot}' in ${instance.topology.state_dir}/projects.json. ` +
						"Open the gmux UI and add this directory as a project first.",
				);
			}
			ok(`Project slug: ${slug}`);

			// ── 4. Auth + navigate ─────────────────────────────────────────────────

			const daemonBase = `http://localhost:${instance.listenPort}`;
			const routeClean = params.route.replace(/^\//, "");
			const appUrl = routeClean ? `${baseUrl}/${slug}/${routeClean}` : `${baseUrl}/${slug}`;

			try {
				info(`Auth → ${daemonBase}/auth/login`);
				sh(`agent-browser navigate "${daemonBase}/auth/login?token=${token}"`);
			} catch (e) {
				return fail(`agent-browser navigate (auth) failed: ${e}`);
			}

			try {
				info(`Navigate → ${appUrl}`);
				sh(`agent-browser navigate "${appUrl}"`);
			} catch (e) {
				return fail(`agent-browser navigate (route) failed: ${e}`);
			}
			ok(`At ${appUrl}`);

			// ── 5. Screenshot ──────────────────────────────────────────────────────

			const screenshotPath =
				params.screenshotPath ?? join(tmpdir(), `gmux-verify-${Date.now()}.png`);
			try {
				sh(`agent-browser screenshot "${screenshotPath}"`);
				ok(`Screenshot → ${screenshotPath}`);
			} catch (e) {
				info(`Screenshot failed (non-fatal): ${e}`);
			}

			// ── 6. Return ──────────────────────────────────────────────────────────

			const daemonRev = instance.topology.vcs?.revision?.slice(0, 7) ?? "unknown";
			return {
				content: [
					{
						type: "text" as const,
						text: [
							...lines,
							"",
							`URL:          ${appUrl}`,
							`Scenario:     ${params.scenario}`,
							`Daemon:       ${instance.topology.instance} :${instance.listenPort} @ ${daemonRev}`,
							`Screenshot:   ${screenshotPath}`,
						].join("\n"),
					},
				],
				details: {
					scenario: params.scenario,
					url: appUrl,
					slug,
					daemonPort: instance.listenPort,
					appPort,
					screenshotPath,
					daemonRevision: daemonRev,
				},
			};
		},
	});
}
