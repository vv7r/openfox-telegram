/**
 * openfox-telegram — bridges Telegram to the OpenFox server it runs in.
 *
 * Plain ESM, zero third-party dependencies. Uses only Node built-ins:
 * global `fetch` and global `WebSocket` (Node >= 22).
 *
 * Exports the public plugin surface (`register`, `deactivate`) plus the
 * injectable building blocks used by the unit tests.
 */

import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_BASE_URL = 'http://127.0.0.1:10369'
const TELEGRAM_MAX_LEN = 4096
const TYPING_INTERVAL_MS = 4000
const POLL_TIMEOUT_SEC = 30
// Time limit of a request to Telegram or OpenFox; file transfers get more.
const REQUEST_TIMEOUT_MS = 30_000
const TRANSFER_TIMEOUT_FACTOR = 4
const TURN_TIMEOUT_MS = 300000
const PROGRESS_MAX_STEPS = 15
// How often follow-mode watchers are checked (setting toggled, socket dropped).
const FOLLOW_SYNC_MS = 30_000
// Above this length, the answer is sent as a .md file.
const LONG_ANSWER_CHARS = 7000
// Characters shown per message in the history of a session that is opened.
const HISTORY_MESSAGE_CHARS = 500

// The runtime is stored in globalThis so that a re-import of this module can
// still reach and stop the previous runtime. OpenFox re-imports plugins with a
// cache-bust query string (?v=...), which creates a fresh ESM module instance
// where the module-scoped `runtime` is undefined; without a shared reference,
// each (re)load would leak a runtime whose poll loop and watchers keep
// forwarding every answer multiple times.
const RUNTIME_KEY = Symbol.for('openfox-telegram-runtime')

// Commands registered with Telegram via setMyCommands: typing "/" lists them.
// French by default, English for Telegram apps set to English. Names are
// a-z, 0-9 and "_" only; descriptions at most 256 characters.
export const BOT_COMMANDS = [
  { command: 'start', description: 'Choisir un projet et une session' },
  { command: 'stop', description: "Arrêter l'agent" },
  { command: 'agents', description: "Changer d'agent, mode nuit" },
  { command: 'status', description: 'État de la session' },
  { command: 'model', description: 'Changer de modèle' },
  { command: 'criteria', description: 'Critères, lancer le build' },
  { command: 'sessions', description: 'Sessions du projet' },
  { command: 'new', description: 'Nouveau projet' },
  { command: 'new_session', description: 'Nouvelle session' },
]
export const BOT_COMMANDS_EN = [
  { command: 'start', description: 'Pick a project and a session' },
  { command: 'stop', description: 'Stop the agent' },
  { command: 'agents', description: 'Switch agent, night mode' },
  { command: 'status', description: 'Session status' },
  { command: 'model', description: 'Switch model' },
  { command: 'criteria', description: 'Criteria, start the build' },
  { command: 'sessions', description: 'Sessions of the project' },
  { command: 'new', description: 'New project' },
  { command: 'new_session', description: 'New session' },
]

const MESSAGES = {
  fr: {
    nothing_to_stop: 'Rien à arrêter.',
    progress_earlier: '… {n} étapes précédentes',
    answer_by_message: '✍️ Répondez par un message.',
    night_button: '🌙 Mode nuit : {state}',
    night_enabled: 'activé',
    night_disabled: 'désactivé',
    night_on: "🌙 Mode nuit activé : l'agent agit sans demander d'autorisation.",
    night_off: '☀️ Mode nuit désactivé : l\'agent demande les autorisations.',
    night_active_note: "🌙 Mode nuit actif : l'agent agit sans demander d'autorisation.",
    status: '📁 Projet : {project}\n💬 Session : {session}\n🤖 Agent : {mode}\n🔤 Modèle : {model}\n🌙 Mode nuit : {night}\n⏳ Agent : {activity}\n🧠 Contexte : {context}',
    status_running: 'en cours',
    status_idle: 'au repos',
    answer_sent: '✅ Réponse envoyée.',
    queued: "📥 Ajouté à la file : l'agent le lira après sa tâche en cours.",
    file_too_big: '⚠️ Fichier trop volumineux (20 Mo maximum).',
    file_unsupported: '⚠️ Type de fichier non pris en charge : images, PDF ou fichiers texte.',
    question_expired: '⚠️ Cette question a expiré.',
    question_gone_forward: "ℹ️ Cette question n'attend plus de réponse (répondue ailleurs ou expirée) : ton message est envoyé à l'agent.",
    yes: 'Oui',
    no: 'Non',
    usage_new: 'Usage : /new <nom>',
    usage_send: 'Usage : /send <idSession> <texte>',
    session_active_continue: 'Session {id} est active. Envoyez-moi un message.',
    no_project_n: 'Pas de projet n°{n}. Utilisez /start.',
    no_session_n: 'Pas de session n°{n}.',
    session_active_select: 'Session "{title}"',
    use_start_first: "Utilisez /start d'abord.",
    project_created: 'Projet "{name}" créé ({id}). Choisissez une session.',
    failed_create_project: 'Échec de création du projet : {err}',
    pick_project_first: "Choisissez d'abord un projet (/start).",
    send_session_title: 'Envoyez le titre de la nouvelle session.',
    session_created: 'Session "{title}" créée ({id}). Envoyez-moi un message.',
    failed_create_session: 'Échec de création de la session : {err}',
    no_active_session: 'Pas de session active. Utilisez /start pour en choisir une.',
    no_agents: 'Aucun agent disponible.',
    agents_choose: 'Choisis un agent :',
    projects_header: '📂 Projets',
    status_unreadable: "⚠️ Impossible de lire l'état de la session : {err}",
    long_answer: '📄 Réponse longue ({n} caractères) : le texte complet est dans le fichier.',
    from_openfox: '💻 *Depuis OpenFox*',
    agents_current: '🤖 Agent actuel : {name}',
    usage_agent: 'Usage : /agent <id> (voir /agents)',
    pick_session_first: "Choisissez d'abord une session (/start).",
    failed_set_agent: "Échec de définition de l'agent : {err}",
    choose_project: 'Choisissez un projet :',
    no_projects: 'Aucun projet. Créez-en un.',
    btn_new_project: '➕ Nouveau projet',
    choose_session: '📁 {project}\nChoisissez une session :',
    no_sessions: '📁 {project}\nAucune session dans ce projet.',
    btn_new_session: '➕ Nouvelle session',
    btn_back_projects: '← Retour projets',
    send_project_name: 'Envoyez le nom du nouveau projet.',
    pick_project_first_cb: "Choisissez d'abord un projet.",
    send_session_title_cb: 'Envoyez le titre de la nouvelle session.',
    stopped: 'Tour arrêté.',
    agent_set: 'Agent défini sur "{mode}" pour la session « {title} ».',
    turn_timeout: '⚠️ Le tour a expiré sans réponse. Réessayez.',
    path_reason_dangerous: 'commande dangereuse',
    path_reason_outside: 'accès hors dossier',
    path_reason_sensitive: 'fichier sensible',
    path_reason_both: 'fichier sensible hors du projet',
    path_reason_git: 'git --no-verify',
    path_everything: 'Tout autoriser',
    path_everything_allowed: '✅ Mode dangereux activé : tout est autorisé pour cette session.',
    path_allow: 'Autoriser',
    path_deny: 'Refuser',
    path_allowed: '✅ Autorisé.',
    path_denied: '❌ Refusé.',
    path_danger_level_failed: '⚠️ Chemin autorisé, mais le mode dangereux n’a pas pu être activé.',
    history_header: '📜 Historique :',
    history_you: '👤 Vous :',
    history_agent: '🤖 Agent :',
    night_unreadable: "⚠️ Impossible de lire le mode nuit de la session, réessayez.",
    invalid_project_name: 'Nom de projet invalide : lettres sans accents, chiffres, points, tirets, soulignés et espaces seulement.',
    model_choose: 'Choisis un modèle :',
    model_set: 'Modèle défini sur "{model}" pour la session « {title} ».',
    model_default: 'modèle par défaut',
    provider_choose: 'Choisis un fournisseur :',
    model_for_new_session: 'Nouvelle session « {title} » : choisis un modèle, ou garde le modèle par défaut.',
    model_default_btn: '⏭️ Modèle par défaut',
    model_cancel_btn: '✖️ Annuler',
    model_close_btn: '✖️ Fermer',
    model_back_btn: '↩️ Fournisseurs',
    model_page: 'Page {page}/{pages} · {count} modèles',
    model_page_one: 'Page {page}/{pages} · 1 modèle',
    model_filter_hint: '🔎 Tape une partie du nom pour filtrer.',
    model_filter_active: '🔎 Filtre : « {filter} »',
    model_no_match: 'Aucun modèle ne contient « {filter} ».',
    model_closed: 'Choix du modèle fermé.',
    choice_expired: '⚠️ Ce choix a expiré : relance /model.',
    criteria_header: '📋 Critères de la session',
    criteria_none: '📋 Aucun critère dans cette session.',
    criteria_more: '… et {n} autres',
    btn_criteria_add: '➕ Ajouter',
    btn_criteria_view: '📋 Voir les critères',
    btn_criteria_agent: '🤖 Ajouter les critères proposés',
    btn_criteria_close: '✖ Annuler',
    command_sent: '🤖 Commande envoyée à l\'agent : {name}.',
    command_failed: '⚠️ Commande impossible : {err}',
    criteria_add_prompt: '✏️ Envoie le critère à ajouter (un par ligne pour en ajouter plusieurs). Une commande annule.',
    criteria_added_one: '✅ 1 critère ajouté.',
    criteria_added: '✅ {n} critères ajoutés.',
    criteria_add_failed: '⚠️ Ajout impossible : {err}',
    build_offer_one: '📋 1 critère en attente : lancer le build ?',
    build_offer: '📋 {n} critères en attente : lancer le build ?',
    workflow_params_hidden: 'Les workflows à paramètres se lancent depuis l\'interface web.',
    workflow_steps: '{name} : le workflow complet, ou une seule de ses étapes ?',
    btn_workflow_full: 'Workflow complet',
    workflow_started: '▶ {name} lancé.',
    workflow_queued: '📥 {name} mis en file : il démarrera après le tour en cours.',
    workflow_failed: '⚠️ Lancement impossible : {err}',
    launch_expired: '⚠️ Ce bouton a expiré : relance /criteria.',
    workflow_resumed: '▶ {name} reprend.',
    workflow_waiting: '⏸ {name} attend ton choix ({step}) :',
    btn_workflow_continue: '▶ Continuer {name} ({step})',
    no_models: 'Aucun modèle disponible.',
    creation_cancelled: 'Création annulée.',
    model_set_failed: '⚠️ Le modèle n’a pas pu être défini : {err}',
  },
  en: {
    nothing_to_stop: 'Nothing to stop right now.',
    progress_earlier: '… {n} earlier steps',
    answer_by_message: '✍️ Reply with a message.',
    night_button: '🌙 Night mode: {state}',
    night_enabled: 'on',
    night_disabled: 'off',
    night_on: '🌙 Night mode on: the agent acts without asking for permission.',
    night_off: '☀️ Night mode off: the agent asks for permission.',
    night_active_note: '🌙 Night mode on: the agent acts without asking for permission.',
    status: '📁 Project: {project}\n💬 Session: {session}\n🤖 Agent: {mode}\n🔤 Model: {model}\n🌙 Night mode: {night}\n⏳ Agent: {activity}\n🧠 Context: {context}',
    status_running: 'working',
    status_idle: 'idle',
    answer_sent: '✅ Answer sent.',
    queued: '📥 Queued: the agent reads it after its current task.',
    file_too_big: '⚠️ File too big (20 MB maximum).',
    file_unsupported: '⚠️ Unsupported file type: images, PDFs or text files.',
    question_expired: '⚠️ This question has expired.',
    question_gone_forward: 'ℹ️ This question is no longer waiting for an answer (answered elsewhere or expired): your message goes to the agent.',
    yes: 'Yes',
    no: 'No',
    usage_new: 'Usage: /new <name>',
    usage_send: 'Usage: /send <sessionId> <text>',
    session_active_continue: 'Session {id} is now active. Send me a message.',
    no_project_n: 'No project #{n}. Use /start.',
    no_session_n: 'No session #{n}.',
    session_active_select: 'Session "{title}"',
    use_start_first: 'Use /start first.',
    project_created: 'Project "{name}" created ({id}). Now choose a session.',
    failed_create_project: 'Failed to create project: {err}',
    pick_project_first: 'Pick a project first (/start).',
    send_session_title: 'Send the title for the new session.',
    session_created: 'Session "{title}" created ({id}). Send me a message.',
    failed_create_session: 'Failed to create session: {err}',
    no_active_session: 'No active session. Use /start to pick one.',
    no_agents: 'No agents available.',
    agents_choose: 'Pick an agent:',
    projects_header: '📂 Projects',
    status_unreadable: '⚠️ Could not read the session status: {err}',
    long_answer: '📄 Long answer ({n} characters): the full text is in the file.',
    from_openfox: '💻 *From OpenFox*',
    agents_current: '🤖 Current agent: {name}',
    usage_agent: 'Usage: /agent <id> (see /agents)',
    pick_session_first: 'Pick a session first (/start).',
    failed_set_agent: 'Failed to set agent: {err}',
    choose_project: 'Choose a project:',
    no_projects: 'No projects. Create one.',
    btn_new_project: '➕ New project',
    choose_session: '📁 {project}\nChoose a session:',
    no_sessions: '📁 {project}\nNo sessions in this project.',
    btn_new_session: '➕ New session',
    btn_back_projects: '← Back to projects',
    send_project_name: 'Send the name for the new project.',
    pick_project_first_cb: 'Pick a project first.',
    send_session_title_cb: 'Send the title for the new session.',
    stopped: 'Turn stopped.',
    agent_set: 'Agent set to "{mode}" for session "{title}".',
    turn_timeout: '⚠️ The turn timed out without an answer. Try again.',
    path_reason_dangerous: 'dangerous command',
    path_reason_outside: 'outside the project folder',
    path_reason_sensitive: 'sensitive file',
    path_reason_both: 'sensitive file outside the project',
    path_reason_git: 'git --no-verify',
    path_everything: 'Allow everything',
    path_everything_allowed: '✅ Dangerous mode on: everything is allowed for this session.',
    path_allow: 'Allow',
    path_deny: 'Deny',
    path_allowed: '✅ Allowed.',
    path_denied: '❌ Denied.',
    path_danger_level_failed: '⚠️ Path confirmed, but danger level could not be set.',
    history_header: '📜 History:',
    history_you: '👤 You:',
    history_agent: '🤖 Agent:',
    night_unreadable: "⚠️ Could not read the session's night mode, try again.",
    invalid_project_name: 'Invalid project name: letters without accents, digits, dots, dashes, underscores and spaces only.',
    model_choose: 'Pick a model:',
    model_set: 'Model set to "{model}" for session "{title}".',
    model_default: 'default model',
    provider_choose: 'Pick a provider:',
    model_for_new_session: 'New session "{title}": pick a model, or keep the default one.',
    model_default_btn: '⏭️ Default model',
    model_cancel_btn: '✖️ Cancel',
    model_close_btn: '✖️ Close',
    model_back_btn: '↩️ Providers',
    model_page: 'Page {page}/{pages} · {count} models',
    model_page_one: 'Page {page}/{pages} · 1 model',
    model_filter_hint: '🔎 Type part of a name to filter.',
    model_filter_active: '🔎 Filter: "{filter}"',
    model_no_match: 'No model contains "{filter}".',
    model_closed: 'Model choice closed.',
    choice_expired: '⚠️ This choice has expired: run /model again.',
    criteria_header: '📋 Session criteria',
    criteria_none: '📋 No criteria in this session.',
    criteria_more: '… and {n} more',
    btn_criteria_add: '➕ Add',
    btn_criteria_view: '📋 Show the criteria',
    btn_criteria_agent: '🤖 Add the proposed criteria',
    btn_criteria_close: '✖ Cancel',
    command_sent: '🤖 Command sent to the agent: {name}.',
    command_failed: '⚠️ Could not run the command: {err}',
    criteria_add_prompt: '✏️ Send the criterion to add (one per line to add several). A command cancels.',
    criteria_added_one: '✅ 1 criterion added.',
    criteria_added: '✅ {n} criteria added.',
    criteria_add_failed: '⚠️ Could not add: {err}',
    build_offer_one: '📋 1 pending criterion: start the build?',
    build_offer: '📋 {n} pending criteria: start the build?',
    workflow_params_hidden: 'Workflows with parameters are started from the web UI.',
    workflow_steps: '{name}: the whole workflow, or one of its steps?',
    btn_workflow_full: 'Whole workflow',
    workflow_started: '▶ {name} started.',
    workflow_queued: '📥 {name} queued: it starts after the current turn.',
    workflow_failed: '⚠️ Could not start: {err}',
    launch_expired: '⚠️ This button has expired: run /criteria again.',
    workflow_resumed: '▶ {name} resumes.',
    workflow_waiting: '⏸ {name} waits for your choice ({step}):',
    btn_workflow_continue: '▶ Continue {name} ({step})',
    no_models: 'No models available.',
    creation_cancelled: 'Creation cancelled.',
    model_set_failed: '⚠️ The model could not be set: {err}',
  },
}

// The project names OpenFox accepts (validateProjectName): the name becomes
// the project's directory, so no path separator and no "..".
function isValidProjectName(name) {
  return /^[a-zA-Z0-9._ -]+$/.test(name) && !name.includes('..')
}

// Wording of a permission request, by the reason OpenFox gives (as the web UI).
const PATH_REASON_KEYS = {
  outside_workdir: 'path_reason_outside',
  sensitive_file: 'path_reason_sensitive',
  both: 'path_reason_both',
  dangerous_command: 'path_reason_dangerous',
  git_no_verify: 'path_reason_git',
}

// chat.done reasons that end a turn ("waiting_for_user" does not: the agent
// waits for an answer; "step_done" ends a workflow step).
const TURN_END_REASONS = new Set(['complete', 'stopped', 'truncated', 'error', 'step_done'])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} }

// ---------------------------------------------------------------------------
// cleanBotToken — a bot token copy-pasted from a JSON snippet or a quoted
// field arrives wrapped in literal quotes (e.g. '"123:ABC"'). Those quotes
// break the Bot API URL and make every call return 404. Strip them (and any
// surrounding whitespace) so the token is always a bare `digits:token`.
// ---------------------------------------------------------------------------
export function cleanBotToken(token) {
  if (typeof token !== 'string') return ''
  return token.trim().replace(/^["']+/, '').replace(/["']+$/, '').trim()
}

// ---------------------------------------------------------------------------
// normalizeUserId — the authorized Telegram user ID is stored as a settings
// string, but the Bot API compares it against an integer user id. Normalize
// to a number (or null when unset/invalid) so the strict comparison works.
// An empty/whitespace value means "not set".
// ---------------------------------------------------------------------------
export function normalizeUserId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

// Reply-keyboard keys. A key sends its label as plain text, so the labels
// carry an icon: only these exact texts run a command, while a word typed
// by hand ("stop") is a normal message and typed commands keep their slash.
export const KEYS = { start: '▶️ start', stop: '⏹ stop', agents: '🤖 agents', status: '📊 status' }

// Buttons of the projects, sessions and agents lists (not of a question or a confirmation).
function isListChoice(data) {
  const d = String(data)
  return /^(proj|sess|agent|prv|mdl|mpg|mpb|mdf|mcx):/.test(d) || ['new_proj', 'new_sess', 'reset', 'night:toggle'].includes(d)
}

// Model lists: models per page, and how long an open list captures typed
// text (as a filter) before typed text goes to the agent again.
const MODEL_PAGE_SIZE = 10
const MODEL_PICKER_TTL_MS = 10 * 60 * 1000

// A model id as shown on a button: a local file path by its file name
// ("C:\\…\\model.gguf" -> "model.gguf"), any other id as is.
function modelLabel(id) {
  return id.includes('\\') || id.startsWith('/') ? id.split(/[\\/]/).pop() : id
}

// Criteria as listed in Telegram: an icon per state, long descriptions cut.
const CRITERION_ICONS = { pending: '⏳', in_progress: '🔄', completed: '☑️', passed: '✅', done: '✅', failed: '❌' }
const CRITERION_TEXT_MAX = 300
const CRITERIA_LIST_MAX_CHARS = 3500
// How long a workflow launch waits for its event subscription to open.
const WS_READY_WAIT_MS = 2000
// A workflow's summary card counts as this run's from a little before its launch (clock rounding).
const CARD_CLOCK_SLACK_MS = 2000

// The end of a workflow, as the web UI's summary card (a "task-completed"
// message of OpenFox): name, iterations, time, tool calls, tokens, speed.
const SUMMARY_WORDS = {
  fr: { over: 'terminé', iteration: ['itération', 'itérations'], toolCall: ["appel d'outil", "appels d'outils"] },
  en: { over: 'finished', iteration: ['iteration', 'iterations'], toolCall: ['tool call', 'tool calls'] },
}

function summaryNumber(n, locale, decimals = 1) {
  const text = Number(n).toFixed(decimals).replace(/\.0+$/, '')
  return locale === 'en' ? text : text.replace('.', ',')
}

function summaryTokens(n, locale) {
  if (n >= 1_000_000) return `${summaryNumber(n / 1_000_000, locale)}M`
  if (n >= 1_000) return `${summaryNumber(n / 1_000, locale)}k`
  return String(n)
}

function summaryTime(seconds, locale) {
  const total = Math.round(Number(seconds) || 0)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  const fr = locale !== 'en'
  if (h > 0) return fr ? `${h} h ${m} min ${sec} s` : `${h}h ${m}m ${sec}s`
  if (m > 0) return fr ? `${m} min ${sec} s` : `${m}m ${sec}s`
  return fr ? `${sec} s` : `${sec}s`
}

/** The summary of a finished workflow; without its card (interrupted run), its name only. */
export function workflowSummary(data, locale = 'fr', fallbackName = '') {
  const words = SUMMARY_WORDS[locale] ?? SUMMARY_WORDS.fr
  const title = `🏁 ${data?.workflowName ?? fallbackName} ${words.over}`
  if (!data || typeof data !== 'object') return title
  const count = (n, [one, many]) => `${n} ${n === 1 ? one : many}`
  const speed = data.avgGenerationSpeed > 0 ? summaryNumber(data.avgGenerationSpeed, locale) : '—'
  const stats = [
    count(data.iterations ?? 0, words.iteration),
    summaryTime(data.totalTimeSeconds, locale),
    count(data.totalToolCalls ?? 0, words.toolCall),
    `${summaryTokens(data.totalTokensGenerated ?? 0, locale)} tokens`,
    `${speed} tok/s`,
  ]
  return `${title}\n${stats.join(' · ')}`
}

// The criteria by state, as one line (the list itself is /criteria).
const CRITERIA_COUNT = {
  fr: {
    label: '📋 Critères : ',
    states: [
      [['passed', 'done'], '✅', ['validé', 'validés']],
      [['completed'], '☑️', ['fait', 'faits']],
      [['in_progress'], '🔄', ['en cours', 'en cours']],
      [['pending'], '⏳', ['en attente', 'en attente']],
      [['failed'], '❌', ['échoué', 'échoués']],
    ],
  },
  en: {
    label: '📋 Criteria: ',
    states: [
      [['passed', 'done'], '✅', ['passed', 'passed']],
      [['completed'], '☑️', ['completed', 'completed']],
      [['in_progress'], '🔄', ['in progress', 'in progress']],
      [['pending'], '⏳', ['pending', 'pending']],
      [['failed'], '❌', ['failed', 'failed']],
    ],
  },
}

export function criteriaCountLine(criteria, locale = 'fr') {
  if (!criteria?.length) return null
  const { label, states } = CRITERIA_COUNT[locale] ?? CRITERIA_COUNT.fr
  const parts = []
  for (const [statuses, icon, [one, many]] of states) {
    const n = criteria.filter((c) => statuses.includes(c.status)).length
    if (n > 0) parts.push(`${icon} ${n} ${n === 1 ? one : many}`)
  }
  return parts.length ? label + parts.join(' · ') : null
}

/** The card of a finished workflow in a chat.message, or null. */
function taskCompletedOf(payload) {
  const m = payload?.message
  if (m?.messageKind !== 'task-completed' || typeof m.content !== 'string') return null
  try {
    const data = JSON.parse(m.content)
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

// Agents offered by the agents key, in this order.
const SELECTABLE_AGENTS = ['builder', 'planner']

// The keys under the input. is_persistent: Telegram keeps them shown instead
// of folding them behind a keyboard icon (they looked gone after a restart).
// Without an active session only the start key is useful.
function menuKeyboard({ session = true } = {}) {
  const keys = session ? [KEYS.start, KEYS.stop, KEYS.agents, KEYS.status] : [KEYS.start]
  return { keyboard: [keys], resize_keyboard: true, is_persistent: true }
}

const KEYBOARD_COMMANDS = {
  [KEYS.start]: '/start',
  [KEYS.stop]: '/stop',
  [KEYS.agents]: '/agents',
  [KEYS.status]: '/status',
}

// ---------------------------------------------------------------------------
// isCommand — true when a message is a recognized slash command. Used so that
// in a pending-confirmation stage, an absolute-path workdir (which starts with
// "/") is treated as the continuation value, not swallowed by the command
// handlers.
// ---------------------------------------------------------------------------
function isCommand(t) {
  return (
    t === '/start' ||
    t === '/reset' ||
    t === '/stop' ||
    t === '/new' ||
    t.startsWith('/new ') ||
    t === '/new-session' ||
    t.startsWith('/new-session ') ||
    t === '/new_session' ||
    t.startsWith('/new_session ') ||
    t.startsWith('/sessions') ||
    t.startsWith('/send ') ||
    t.startsWith('/continue ') ||
    t === '/agents' ||
    t === '/status' ||
    t === '/model' ||
    t === '/criteria'
  )
}

// ---------------------------------------------------------------------------
// stripSystemReminders — removes <system-reminder>...</system-reminder>
// blocks from agent text so they never leak to the Telegram user.
// ---------------------------------------------------------------------------
export function stripSystemReminders(text) {
  if (typeof text !== 'string') return text
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

// The command, path, URL or query a tool call works on.
function toolDetail(tool, args) {
  let detail = ''
  if (tool === 'run_command') {
    detail = args?.command ?? ''
  } else if (tool === 'read_file' || tool === 'write_file' || tool === 'edit_file') {
    detail = args?.path ?? ''
  } else if (tool === 'web_fetch') {
    detail = args?.url ?? ''
  } else if (tool === 'web_search') {
    detail = args?.query ?? ''
  }
  return String(detail)
}

// One step of the progress message. A long or multi-line detail (a long
// command) folds into an expandable quote, opened with a tap.
const PROGRESS_FOLD_CHARS = 60
const PROGRESS_DETAIL_MAX = 600
const PROGRESS_MAX_CHARS = 3800

function progressStep(icon, tool, args, html) {
  let detail = toolDetail(tool, args)
  if (detail.length > PROGRESS_DETAIL_MAX) detail = `${detail.slice(0, PROGRESS_DETAIL_MAX)}…`
  if (!html) return detail ? `${icon} ${tool} · ${detail}` : `${icon} ${tool}`
  if (detail.length > PROGRESS_FOLD_CHARS || detail.includes('\n')) {
    return `${icon} ${escapeHtml(tool)}\n<blockquote expandable>${escapeHtml(detail)}</blockquote>`
  }
  return escapeHtml(detail ? `${icon} ${tool} · ${detail}` : `${icon} ${tool}`)
}

// ---------------------------------------------------------------------------
// markdownToTelegramHtml — the agent writes markdown; Telegram shows a small
// HTML subset (parse_mode HTML): b, i, s, code, pre, a, blockquote. Code is
// kept verbatim (escaped), everything else is escaped before formatting.
// ---------------------------------------------------------------------------
const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function markdownToTelegramHtml(markdown) {
  const slots = []
  const keep = (html) => {
    slots.push(html)
    return `\u0000${slots.length - 1}\u0000`
  }
  let text = String(markdown)
  // Fenced code blocks, then inline code: verbatim, escaped.
  text = text.replace(/```([\w+-]*)[^\S\n]*\n([\s\S]*?)\n?```/g, (_m, lang, code) =>
    keep(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(code)}</code></pre>`),
  )
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => keep(`<code>${escapeHtml(code)}</code>`))
  // Links before escaping, so their URL can be escaped as an attribute.
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) =>
    keep(`<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${escapeHtml(label)}</a>`),
  )
  text = escapeHtml(text)
  text = text
    .split('\n')
    .map((line) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(line)
      if (heading) return `<b>${heading[1]}</b>`
      const quote = /^&gt;\s?(.*)$/.exec(line)
      if (quote) return `<blockquote>${quote[1]}</blockquote>`
      return line.replace(/^(\s*)[-*]\s+/, '$1• ')
    })
    .join('\n')
  text = text
    .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/__(?=\S)([^_\n]+?)__/g, '<b>$1</b>')
    .replace(/~~(?=\S)([^~\n]+?)~~/g, '<s>$1</s>')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, '$1<i>$2</i>')
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i) => slots[Number(i)])
}

// Markdown cut into pieces whose HTML fits in one Telegram message: escaping
// and tags make the HTML longer than its markdown, so a piece too long once
// converted is cut again, smaller.
export function htmlChunks(markdown, max = 3500) {
  const parts = []
  for (const md of chunkMessage(markdown, max)) {
    const html = markdownToTelegramHtml(md)
    if (html.length <= TELEGRAM_MAX_LEN || max <= 200) parts.push({ md, html })
    else parts.push(...htmlChunks(md, Math.floor(max / 2)))
  }
  return parts
}

// chunkMessage — split a message into chunks of at most `max` characters.
// Prefers to break on newlines so paragraphs stay readable.
export function chunkMessage(text, max = TELEGRAM_MAX_LEN) {
  if (text.length <= max) return [text]
  const chunks = []
  let rest = text
  while (rest.length > max) {
    const nl = rest.lastIndexOf('\n', max - 1)
    const cut = nl > 0 ? nl + 1 : max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

// ---------------------------------------------------------------------------
// Attachments: a photo or file the user sends, in OpenFox's format (images
// and PDFs as data URLs, text as text).
// ---------------------------------------------------------------------------
/** The photo (its largest size) or document of a Telegram message, or null. */
function fileOf(msg) {
  if (msg.photo?.length) {
    const p = msg.photo.reduce((a, b) => ((b.file_size ?? 0) >= (a.file_size ?? 0) ? b : a))
    return { fileId: p.file_id, filename: 'photo.jpg', mimeType: 'image/jpeg', size: p.file_size ?? 0 }
  }
  const d = msg.document
  if (d) return { fileId: d.file_id, filename: d.file_name ?? 'file', mimeType: d.mime_type ?? 'application/octet-stream', size: d.file_size ?? 0 }
  return null
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024
const DATA_URL_TYPES = /^(image\/(jpeg|png|gif|webp)|application\/pdf)$/

export function toAttachment({ bytes, filename, mimeType }) {
  const base = { id: `tg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, filename, size: bytes.length }
  if (DATA_URL_TYPES.test(mimeType)) {
    return { ...base, mimeType, data: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}` }
  }
  // Telegram often labels code files application/octet-stream: valid UTF-8
  // without NUL bytes is text.
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  if (text.includes('\u0000')) return null
  const textType = mimeType?.startsWith('text/') || /^application\/(json|xml|javascript|x-sh|x-yaml|toml)$/.test(mimeType ?? '')
  return { ...base, mimeType: textType ? mimeType : 'text/plain', data: text }
}

// ---------------------------------------------------------------------------
// OpenFoxRestClient — thin fetch wrapper over the OpenFox HTTP API.
// ---------------------------------------------------------------------------
export class OpenFoxRestClient {
  constructor({ baseUrl, fetchImpl, requestTimeoutMs, WebSocketImpl } = {}) {
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.fetch = fetchImpl ?? fetch
    this.requestTimeoutMs = requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.WebSocketImpl = WebSocketImpl ?? null
  }

  async _request(path, { method = 'GET', body } = {}) {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    let data
    try {
      data = await res.json()
    } catch {
      data = {}
    }
    if (res.status >= 400) {
      const err = new Error(`OpenFox ${res.status}: ${data?.error ?? 'request failed'}`)
      err.status = res.status
      throw err
    }
    return data
  }

  async listProjects() {
    return (await this._request('/api/projects')).projects ?? []
  }

  async createProject(name, workdir) {
    return (await this._request('/api/projects', { method: 'POST', body: { name, workdir } })).project
  }

  async listSessions(projectId) {
    return (await this._request(`/api/sessions?projectId=${encodeURIComponent(projectId)}`)).sessions ?? []
  }

  async createSession(projectId, title) {
    return (await this._request('/api/sessions', { method: 'POST', body: { projectId, title } })).session
  }

  // messageKind 'command': a command of OpenFox (e.g. "Add criteria"), as the web UI sends it.
  async sendMessage(sessionId, content, attachments, { messageKind } = {}) {
    return this._request(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      body: { content, ...(attachments?.length ? { attachments } : {}), ...(messageKind ? { messageKind } : {}) },
    })
  }

  /** A command of OpenFox ({ metadata: { id, name, agentMode? }, prompt }), with the workdir's own version if it has one. */
  async getCommand(commandId, workdir) {
    const query = workdir ? `?workdir=${encodeURIComponent(workdir)}` : ''
    return this._request(`/api/commands/${encodeURIComponent(commandId)}${query}`)
  }

  // Stop the agent working on a session (what the web UI's stop button does).
  async stopSession(sessionId) {
    return this._request(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' })
  }

  async listAgents() {
    return (await this._request('/api/agents')).defaults ?? []
  }

  async getLocale() {
    const data = await this._request('/api/settings/display.locale')
    const value = data.value ?? 'automatic'
    return value === 'en' ? 'en' : 'fr'
  }

  async getDefaultWorkdir() {
    const config = await this._request('/api/config')
    return config.workdir ?? ''
  }

  async setSessionMode(sessionId, mode) {
    return (await this._request(`/api/sessions/${encodeURIComponent(sessionId)}/mode`, {
      method: 'PUT',
      body: { mode },
    })).session
  }

  // Night mode: the agent acts without asking for permission.
  async setNightMode(sessionId, nightMode) {
    return this._request(`/api/sessions/${encodeURIComponent(sessionId)}/night-mode`, {
      method: 'PUT',
      body: { nightMode },
    })
  }

  // Answer the agent's question (ask_user): confirm → "yes"/"no", choice → the option value.
  async answerQuestion(sessionId, callId, answer) {
    return this._request(`/api/sessions/${encodeURIComponent(sessionId)}/answer`, {
      method: 'POST',
      body: { callId, answer },
    })
  }

  async confirmPath(sessionId, callId, approved, alwaysAllow = false) {
    return this._request(`/api/sessions/${encodeURIComponent(sessionId)}/confirm-path`, {
      method: 'POST',
      body: { callId, approved, alwaysAllow },
    })
  }

  async setDangerLevel(sessionId, dangerLevel) {
    return this._request(`/api/sessions/${encodeURIComponent(sessionId)}/danger-level`, {
      method: 'PUT',
      body: { dangerLevel },
    })
  }

  async getSessionDetail(sessionId) {
    const data = await this._request(`/api/sessions/${encodeURIComponent(sessionId)}?full=true`)
    return data
  }

  /** The providers, each with its models ({ id, ... }), and the active provider id. */
  async listProviders() {
    const data = await this._request('/api/providers')
    return { providers: data.providers ?? [], activeProviderId: data.activeProviderId ?? null }
  }

  async setSessionProvider(sessionId, providerId, model) {
    return (await this._request(`/api/sessions/${encodeURIComponent(sessionId)}/provider`, {
      method: 'POST',
      body: { providerId, model },
    })).session
  }

  /** The workflows of a workdir: built-in, then the user's, then the project's (as the web UI lists them). */
  async listWorkflows(workdir) {
    const data = await this._request(workdir ? `/api/workflows?workdir=${encodeURIComponent(workdir)}` : '/api/workflows')
    return [...(data.defaults ?? []), ...(data.userItems ?? []), ...(data.projectItems ?? [])]
  }

  /** Replace the session's criteria (the whole list, as the web UI does). */
  async setCriteria(sessionId, criteria) {
    return this._request(`/api/sessions/${encodeURIComponent(sessionId)}/criteria`, {
      method: 'PUT',
      body: { criteria },
    })
  }

  /**
   * Start a workflow on a session, like the web UI's "▶ Build & Verify". OpenFox
   * has no HTTP route for it: `runner.launch` goes over a short-lived WebSocket
   * (closing it does not stop the workflow). Resolves { status: 'started' } on
   * the ack, { status: 'queued' } when the agent works (OpenFox queues it).
   * With resumeFrom (and stepOutput, params, userChoice), it continues a
   * workflow paused on a step that waits for the user.
   */
  launchWorkflow(sessionId, { workflowId, subGroup, scope, ...resume } = {}) {
    const WS = this.WebSocketImpl ?? globalThis.WebSocket
    const id = `telegram-launch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve, reject) => {
      let ws
      let settled = false
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          ws?.close()
        } catch {}
        fn(value)
      }
      const timer = setTimeout(() => settle(reject, new Error('OpenFox: no answer to the workflow launch')), this.requestTimeoutMs)
      try {
        ws = new WS(wsUrl(this.baseUrl))
      } catch (e) {
        return settle(reject, e)
      }
      ws.addEventListener('open', () => {
        // A resume (resumeFrom, stepOutput, params, userChoice) carries no scope, as in the web UI.
        const payload = {
          sessionId,
          ...(workflowId ? { workflowId } : {}),
          ...(subGroup ? { subGroup } : {}),
          ...resume,
          ...(resume.resumeFrom ? {} : { scope: scope ?? 'auto' }),
        }
        try {
          ws.send(JSON.stringify({ id, type: 'runner.launch', payload }))
        } catch (e) {
          settle(reject, e)
        }
      })
      ws.addEventListener('message', (ev) => {
        let msg
        try {
          msg = JSON.parse(ev.data)
        } catch {
          return
        }
        if (msg?.id !== id) return
        if (msg.type === 'ack') settle(resolve, { status: 'started' })
        else if (msg.type === 'queue.state') settle(resolve, { status: 'queued' })
        else if (msg.type === 'error') settle(reject, new Error(msg.payload?.message ?? 'workflow launch refused'))
      })
      const dropped = () => settle(reject, new Error('OpenFox: connection closed before the workflow launch was confirmed'))
      ws.addEventListener('close', dropped)
      ws.addEventListener('error', dropped)
    })
  }
}

// ---------------------------------------------------------------------------
// TelegramClient — thin fetch wrapper over the Bot API.
// ---------------------------------------------------------------------------
export class TelegramClient {
  constructor({ token, fetchImpl, requestTimeoutMs } = {}) {
    this.token = cleanBotToken(token)
    this.fetch = fetchImpl ?? fetch
    this.requestTimeoutMs = requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this._abortController = new AbortController()
  }

  abort() {
    this._abortController.abort()
  }

  // Every request has a time limit: a connection that stalls without closing
  // must not freeze the bot.
  async _call(method, params, timeoutMs = this.requestTimeoutMs) {
    const url = `https://api.telegram.org/bot${this.token}/${method}`
    // A FormData body (a file upload) sets its own multipart content type.
    const form = params instanceof FormData
    const res = await this.fetch(url, {
      method: 'POST',
      ...(form ? {} : { headers: { 'Content-Type': 'application/json' } }),
      body: form ? params : JSON.stringify(params),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this._abortController.signal]),
    })
    let data
    try {
      data = await res.json()
    } catch {
      data = {}
    }
    if (res.status === 429) {
      const err = new Error('Telegram flood limit (429)')
      err.retryAfterMs = (data?.parameters?.retry_after ?? 3) * 1000
      throw err
    }
    if (res.status === 409) {
      const err = new Error('Telegram conflict (409): bot token in use elsewhere')
      err.conflict = true
      throw err
    }
    if (res.status >= 400 || !data.ok) {
      throw new Error(`Telegram ${res.status}: ${data?.description ?? 'request failed'}`)
    }
    return data.result
  }

  /** Bytes of a file the user sent (the Bot API serves files up to 20 MB). */
  async downloadFile(fileId) {
    const { file_path: filePath } = await this._call('getFile', { file_id: fileId })
    const res = await this.fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`, {
      signal: AbortSignal.timeout(this.requestTimeoutMs * TRANSFER_TIMEOUT_FACTOR),
    })
    if (res.status >= 400) throw new Error(`Telegram ${res.status}: file download failed`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async getUpdates(offset, timeoutSec = POLL_TIMEOUT_SEC) {
    const params = { timeout: timeoutSec }
    if (offset !== undefined) params.offset = offset
    // The long poll lasts timeoutSec on Telegram's side: wait a bit longer.
    return this._call('getUpdates', params, (timeoutSec + 15) * 1000)
  }

  // Returns the last message sent (its message_id lets it be edited later).
  async sendMessage(chatId, text, extra = {}) {
    let sent
    for (const chunk of chunkMessage(text)) {
      sent = await this._call('sendMessage', { chat_id: chatId, text: chunk, ...extra })
    }
    return sent
  }

  async editMessageText(chatId, messageId, text, extra = {}) {
    return this._call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra })
  }

  async sendChatAction(chatId, action) {
    return this._call('sendChatAction', { chat_id: chatId, action })
  }

  async answerCallbackQuery(callbackQueryId) {
    return this._call('answerCallbackQuery', { callback_query_id: callbackQueryId })
  }

  // Remove the inline keyboard of a message (e.g. once a confirmation is answered).
  async editMessageReplyMarkup(chatId, messageId) {
    return this._call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    })
  }

  /** Send a text as a file (e.g. a very long answer as reponse.md). */
  async sendDocument(chatId, filename, content, caption) {
    const form = new FormData()
    form.set('chat_id', String(chatId))
    if (caption) form.set('caption', caption)
    form.set('document', new Blob([content], { type: 'text/markdown' }), filename)
    return this._call('sendDocument', form, this.requestTimeoutMs * TRANSFER_TIMEOUT_FACTOR)
  }

  async getMe() {
    return this._call('getMe', {})
  }

  async deleteMessage(chatId, messageId) {
    return this._call('deleteMessage', { chat_id: chatId, message_id: messageId })
  }

  async setMyCommands(commands, { languageCode } = {}) {
    const params = { commands }
    if (languageCode) params.language_code = languageCode
    return this._call('setMyCommands', params)
  }
}

// ---------------------------------------------------------------------------
// Conversation — per-chat state machine + turn runner.
// ---------------------------------------------------------------------------
export class Conversation {
  constructor({ chatId, telegram, rest, subscribe, logger, typingIntervalMs, turnTimeoutMs, timer, historyCount, historyChars, storage, follow } = {}) {
    this.chatId = chatId
    this.telegram = telegram
    this.rest = rest
    this.subscribe = subscribe
    this.logger = logger ?? noopLogger
    this.typingIntervalMs = typingIntervalMs ?? TYPING_INTERVAL_MS
    this.turnTimeoutMs = turnTimeoutMs ?? TURN_TIMEOUT_MS
    this.follow = follow ?? false
    this._watcher = null
    this._seen = new Set()
    this.historyCount = historyCount ?? 6
    this.historyChars = historyChars ?? HISTORY_MESSAGE_CHARS
    this._setInterval = timer?.setInterval ?? setInterval
    this._clearInterval = timer?.clearInterval ?? clearInterval
    this._setTimeout = timer?.setTimeout ?? setTimeout
    this._clearTimeout = timer?.clearTimeout ?? clearTimeout
    // pendingQuestions: the agent's questions waiting for an answer, by the
    // short token their buttons carry (a callId may not fit in 64 bytes).
    this.state = { stage: 'idle', projectId: null, sessionId: null, pendingQuestions: new Map() }
    this._questionSeq = 0
    this._cachedProjects = []
    this._cachedSessions = []
    // The "📂 Projets" header and the project list of the last start.
    this._projectsMessages = []
    this._stopTyping = null
    this._abortTurn = null
    this._locale = null
    // The active project and session survive a plugin or OpenFox restart.
    this.storage = storage ?? null
    this._savedState = null
    // Messages whose buttons were already removed by the callback handler.
    this._removedButtons = new Set()
    this._restoreState()
  }

  _storageKey() {
    return `chat:${this.chatId}`
  }

  _restoreState() {
    try {
      const raw = this.storage?.get(this._storageKey())
      if (!raw) return
      const saved = JSON.parse(String(raw))
      if (saved?.sessionId) {
        this.state.projectId = saved.projectId ?? null
        this.state.sessionId = saved.sessionId
        this.state.stage = 'active'
      }
    } catch (e) {
      this.logger.warn('telegram: could not restore the active session', { chatId: this.chatId, error: e?.message })
    }
  }

  _saveState() {
    this.syncWatcher()
    if (!this.storage) return
    const value = JSON.stringify({ projectId: this.state.projectId ?? null, sessionId: this.state.sessionId ?? null })
    if (value === this._savedState) return
    try {
      this.storage.set(this._storageKey(), value)
      this._savedState = value
    } catch (e) {
      this.logger.warn('telegram: could not save the active session', { chatId: this.chatId, error: e?.message })
    }
  }

  async _ensureLocale() {
    if (this._locale === null) {
      try {
        this._locale = await this.rest.getLocale()
      } catch {
        this._locale = 'fr'
      }
    }
    return this._locale
  }

  t(key, params = {}) {
    const locale = this._locale ?? 'fr'
    let str = (MESSAGES[locale] ?? MESSAGES.fr)[key] ?? key
    for (const [k, v] of Object.entries(params)) {
      str = str.replaceAll(`{${k}}`, String(v))
    }
    return str
  }

  async _sendTyping(kind) {
    // Log the outcome so a failed chat action is visible in the logs instead
    // of being swallowed (a swallowed 404 hid the broken-token bug).
    try {
      await this.telegram.sendChatAction(this.chatId, 'typing')
      this.logger.debug('telegram: typing indicator sent', { chatId: this.chatId, kind })
    } catch (e) {
      this.logger.warn('telegram: typing indicator failed', { chatId: this.chatId, kind, error: e?.message })
    }
  }

  /** Whether OpenFox says a turn runs on the session (false when it cannot tell). */
  async _stillRunning(sessionId) {
    if (!this.rest.getSessionDetail) return false
    try {
      return Boolean((await this.rest.getSessionDetail(sessionId))?.session?.isRunning)
    } catch {
      return false
    }
  }

  /** "Typing…" shown at once, then kept alive until the returned stop() is called. */
  _typingLoop() {
    void this._sendTyping('immediate')
    const id = this._setInterval(() => {
      void this._sendTyping('tick')
    }, this.typingIntervalMs)
    return () => this._clearInterval(id)
  }

  startTyping() {
    // The indicator of a turn started here, until the turn completes.
    const stop = this._typingLoop()
    this._stopTyping = stop
    return stop
  }

  /**
   * "Typing…" for a turn started from OpenFox (follow mode), separate from the
   * one of a turn started here. It stops on its own after a silence as long as
   * a turn's watchdog, so a missed end never leaves it running.
   */
  _watcherTyping(watcher, on) {
    const gen = (watcher.typingGen = (watcher.typingGen ?? 0) + 1)
    if (on) {
      if (!watcher.stopTyping) watcher.stopTyping = this._typingLoop()
      this._clearTimeout(watcher.typingTimeout)
      // After a silence, OpenFox says whether the turn still runs.
      watcher.typingTimeout = this._setTimeout(() => {
        void this._stillRunning(watcher.sessionId).then((running) => {
          if (watcher.typingGen !== gen || !watcher.stopTyping) return
          this._watcherTyping(watcher, running && watcher.alive)
        })
      }, this.turnTimeoutMs)
      return
    }
    watcher.stopTyping?.()
    watcher.stopTyping = null
    this._clearTimeout(watcher.typingTimeout)
    watcher.typingTimeout = null
  }

  abort() {
    this._stopTyping?.()
    this._stopTyping = null
  }

  /**
   * Abort the currently running turn (if any). Returns true if a turn was
   * aborted, false if there was nothing to stop. Used by /stop.
   */
  stopTurn() {
    if (this._abortTurn) {
      const abort = this._abortTurn
      this._abortTurn = null
      abort()
      return true
    }
    return false
  }

  /**
   * Run one agent turn: subscribe to the session's events, forward the user
   * text, accumulate the assistant's `chat.delta` (never `chat.thinking` nor
   * tool events), show a typing indicator while it runs, and forward the
   * final text on `chat.done`. Resolves when the turn completes.
   *
   * With `launch` ({ workflowId, subGroup, scope, name }), the turn is a
   * workflow started like the web UI's "▶ Build & Verify": each of its steps
   * ends with a chat.done ("step_done"), so the workflow ends when OpenFox
   * says the session no longer runs.
   */
  async runTurn(sessionId, content, attachments, { launch = null, messageKind = null } = {}) {
    this.logger.debug('telegram: turn start', { sessionId })
    this._saveState()
    const deltas = new Map()
    const fallback = new Map()
    const toolCalls = new Map()
    let changes = new FileChanges()
    // Everything this turn sends goes through one ordered queue: progress
    // messages and the agent's texts arrive in the order they happened.
    let out = Promise.resolve()
    const enqueue = (task) => {
      out = out.then(task).catch((e) => this.logger.warn('telegram: send failed', { error: e?.message }))
      return out
    }
    // A progress message lists the tools run since the last text of the
    // agent and is edited as they finish (not one message per tool). After a
    // text, the next tools go into a new progress message (a new segment).
    const newSegment = () => ({ steps: [], messageId: null, lastText: '', queued: false })
    let segment = newSegment()
    const segments = [segment]
    // The last steps that fit (at most PROGRESS_MAX_STEPS, and within
    // Telegram's message length), as HTML or as plain text.
    const renderProgress = (seg, html) => {
      const shown = []
      let length = 0
      for (let i = seg.steps.length - 1; i >= 0 && shown.length < PROGRESS_MAX_STEPS; i--) {
        const step = seg.steps[i]
        const plain = progressStep(step.icon, step.tool, step.args, false)
        if (shown.length > 0 && length + plain.length + 1 > PROGRESS_MAX_CHARS) break
        length += plain.length + 1
        shown.unshift(progressStep(step.icon, step.tool, step.args, html))
      }
      const hidden = seg.steps.length - shown.length
      if (hidden > 0) shown.unshift(this.t('progress_earlier', { n: hidden }))
      return shown.join('\n')
    }
    // Coalesced: one queued update per segment, rendered when it runs.
    const pushProgress = (seg = segment) => {
      if (seg.queued) return out
      seg.queued = true
      return enqueue(() => flushProgress(seg))
    }
    const flushProgress = async (seg) => {
      seg.queued = false
      const text = renderProgress(seg, true)
      if (!text || text === seg.lastText) return
      const show = async (body, extra) => {
        if (seg.messageId == null) {
          const sent = await this.telegram.sendMessage(this.chatId, body, extra)
          seg.messageId = sent?.message_id ?? null
        } else {
          await this.telegram.editMessageText(this.chatId, seg.messageId, body, extra)
        }
      }
      try {
        try {
          await show(text, { parse_mode: 'HTML' })
        } catch (e) {
          this.logger.warn('telegram: progress HTML rejected, sent as plain text', { error: e?.message })
          await show(renderProgress(seg, false), {})
        }
        seg.lastText = text
      } catch (e) {
        this.logger.warn('telegram: progress update failed', { error: e?.message })
      }
    }
    const sentIds = new Set()
    // Send a message of the agent once it is complete (each message once).
    const emitText = (messageId) => {
      if (!messageId || sentIds.has(messageId)) return
      sentIds.add(messageId)
      const text = stripSystemReminders((deltas.get(messageId) ?? fallback.get(messageId) ?? '').trim())
      if (!text) return
      this.logger.info('telegram: forwarding response', { sessionId, chars: text.length })
      if (segment.steps.length) {
        segment = newSegment()
        segments.push(segment)
      }
      enqueue(() => this.sendFormatted(text))
    }
    const endSegment = (messageId) => {
      emitText(messageId)
      const turnChanges = changes
      changes = new FileChanges()
      enqueue(() => this.sendTurnEnd('', turnChanges))
    }
    let finished = false
    // How the turn ended: 'done' when OpenFox ended it (not /stop, a time-out or a failure).
    let endedBy = null
    // A workflow: whether it was seen running (a "not running" state from
    // before its start must not end it).
    let sawRunning = false
    // The summary card of the workflow (its task-completed message).
    let taskCompleted = null
    // When the workflow was started: its card is the first one after.
    let launchedAt = Date.now()
    // An auto-compaction emits a `chat.message` (isCompactionSummary) followed by a
    // `chat.done` ("complete") for the compaction turn, then the agent continues and
    // emits the real answer. The summary id consumes that compaction done so it does
    // not end the turn and swallow the real answer.
    let compactionSummaryId = null
    let resolveDone
    const done = new Promise((resolve) => {
      resolveDone = resolve
    })
    const stopTyping = this.startTyping()
    // Watchdog: if the server never emits chat.done/chat.error (WS drop, hang),
    // fail the turn gracefully instead of spinning the typing indicator forever.
    // It restarts on every event, so it measures inactivity, not the turn's
    // length, and never expires while a question waits for the user's answer.
    // A silence is not the end of the turn (a long command, a slow first
    // token): OpenFox is asked whether the turn still runs before giving up.
    let timeoutId
    let watchdogGen = 0
    const armWatchdog = () => {
      this._clearTimeout(timeoutId)
      const gen = ++watchdogGen
      timeoutId = this._setTimeout(() => {
        if (finished) return
        if (this.hasPendingQuestion()) return armWatchdog()
        void this._stillRunning(sessionId).then((running) => {
          // Activity came back while OpenFox was asked: the watchdog was re-armed.
          if (finished || gen !== watchdogGen) return
          if (running) return armWatchdog()
          // A workflow whose end was missed (it can stop within a second, e.g. on a step waiting for the user).
          if (launch) return finish('done')
          this.logger.warn('telegram: turn timed out', { sessionId, timeoutMs: this.turnTimeoutMs })
          void this.telegram.sendMessage(this.chatId, this.t('turn_timeout'))
          finish('timeout')
        })
      }, this.turnTimeoutMs)
    }
    armWatchdog()
    // Declared before finish(), which uses them: an event may end the turn
    // while the subscription is being set up.
    // Messages sent to OpenFox's queue while this turn runs: their answers
    // are forwarded by this turn too.
    const turn = { sessionId, queued: 0 }
    let cleanup = null
    const finish = (reason = 'aborted') => {
      if (finished) return
      finished = true
      endedBy = reason
      stopTyping()
      this._clearTimeout(timeoutId)
      // The questions of this turn can no longer be answered.
      for (const [token, q] of this.state.pendingQuestions) {
        if (q.sessionId === sessionId) this._forgetQuestion(token)
      }
      // Remove the buttons from path confirmations of this turn.
      if (this.state.pendingPathConfirms) {
        for (const [callId, entry] of this.state.pendingPathConfirms) {
          if (entry.sessionId === sessionId) {
            this.logger.debug('telegram: finish() removing path confirmation buttons', { callId, messageId: entry.messageId })
            if (entry.messageId) {
              void this.telegram.editMessageReplyMarkup(this.chatId, entry.messageId, { inline_keyboard: [] })
                .catch((e) => this.logger.warn('telegram: editMessageReplyMarkup failed', { callId, messageId: entry.messageId, error: e?.message }))
            }
            this.state.pendingPathConfirms.delete(callId)
          }
        }
      }
      cleanup?.()
      resolveDone()
      if (this._abortTurn === finish) this._abortTurn = null
      if (this._turn === turn) this._turn = null
    }
    // Expose an abort handle so /stop can interrupt a running turn.
    this._abortTurn = finish
    this._turnSessionId = sessionId
    this._turn = turn

    // A workflow is launched once the subscription is open, or it could end
    // (within a second) before its events are followed.
    let resolveReady
    const ready = new Promise((resolve) => {
      resolveReady = resolve
    })
    cleanup = this.subscribe(sessionId, (msg) => {
      if (finished) return
      this._markSeen(msg.payload)
      armWatchdog()
      if (msg.type === 'session.running') {
        if (msg.payload?.isRunning) sawRunning = true
        else if (launch && sawRunning) finish('done')
        return
      }
      if (msg.type !== 'chat.thinking') sawRunning = true
      if (msg.type === 'chat.delta') {
        if (msg.payload?.subAgentType) return
        const id = msg.payload.messageId
        deltas.set(id, (deltas.get(id) ?? '') + msg.payload.content)
      } else if (msg.type === 'chat.message') {
        const m = msg.payload?.message
        taskCompleted = taskCompletedOf(msg.payload) ?? taskCompleted
        if (m?.isCompactionSummary && !m.subAgentType) compactionSummaryId = m.id
        if (m?.role === 'assistant' && typeof m.content === 'string') {
          fallback.set(m.id ?? 'm', m.content)
        }
      } else if (msg.type === 'chat.message_updated') {
        // A message of the agent is complete: send it now, not only the last one.
        if (msg.payload?.updates?.isStreaming === false) emitText(msg.payload.messageId)
      } else if (msg.type === 'chat.tool_call') {
        const { callId, tool, args } = msg.payload
        if (callId && tool) {
          toolCalls.set(callId, { tool, args })
          changes.onToolCall(callId, tool, args)
          segment.steps.push({ callId, icon: '⏳', tool, args })
          void pushProgress()
        }
      } else if (msg.type === 'chat.tool_result') {
        const { callId, result } = msg.payload
        const tc = toolCalls.get(callId)
        if (tc) {
          toolCalls.delete(callId)
          changes.onToolResult(callId, Boolean(result?.success))
          const seg = segments.find((sg) => sg.steps.some((st) => st.callId === callId))
          if (seg) {
            seg.steps.find((st) => st.callId === callId).icon = result?.success ? '✓' : '✗'
            void pushProgress(seg)
          }
        }
      } else if (msg.type === 'chat.path_confirmation') {
        this._showPathConfirmation(msg.payload, sessionId)
      } else if (msg.type === 'chat.ask_user') {
        // The agent asks a question and waits (chat.done "waiting_for_user"
        // follows and does not end the turn).
        this._showQuestion(msg.payload, sessionId)
      } else if (msg.type === 'chat.done') {
        if (msg.payload?.agentType === 'sub-agent') {
          this.logger.debug('telegram: chat.done (sub-agent), no finish', { reason: msg.payload.reason })
          return
        }
        if (!TURN_END_REASONS.has(msg.payload.reason)) {
          this.logger.debug('telegram: chat.done (non-terminal reason), no finish', { reason: msg.payload.reason })
          return
        }
        // The compaction turn's own chat.done: the real answer follows, so it
        // must not send the summary nor end the turn.
        const isCompactionDone =
          compactionSummaryId !== null &&
          msg.payload.reason === 'complete' &&
          msg.payload.messageId === compactionSummaryId
        if (isCompactionDone) compactionSummaryId = null
        // The compaction's done is not the done of a queued message: it must
        // not use up a queued continuation, or the turn would end before the
        // answer to the queued message.
        if (isCompactionDone) {
          this.logger.debug('telegram: chat.done (compaction), no finish')
          return
        }
        if (msg.payload.reason === 'complete' && turn.queued > 0) {
          turn.queued--
          endSegment(msg.payload.messageId)
          this.logger.debug('telegram: chat.done (queued), no finish', { queued: turn.queued })
          return
        }
        endSegment(msg.payload.messageId)
        // A workflow goes on with its next step: it ends when the session stops running.
        if (launch) return
        finish('done')
      } else if (msg.type === 'chat.error') {
        const error = msg.payload?.error ?? 'error'
        enqueue(() => this.telegram.sendMessage(this.chatId, `⚠️ ${error}`))
        if (!launch) finish('error')
      }
      // chat.thinking is intentionally ignored.
    }, { onOpen: () => resolveReady() })

    // Ended while subscribing: close the subscription just returned.
    if (finished) cleanup?.()

    try {
      if (launch) {
        const { label, name, ...request } = launch
        launchedAt = Date.now()
        let readyTimer
        await Promise.race([ready, new Promise((resolve) => (readyTimer = setTimeout(resolve, WS_READY_WAIT_MS)))])
        clearTimeout(readyTimer)
        const started = await this.rest.launchWorkflow(sessionId, request)
        // The agent works: OpenFox runs the workflow after the current turn.
        if (started?.status === 'queued') {
          enqueue(() => this.telegram.sendMessage(this.chatId, this.t('workflow_queued', { name: label })))
          finish('queued')
        } else {
          // OpenFox acknowledges once the workflow is set to run: a "not running" state from now on is its end.
          sawRunning = true
          enqueue(() => this.telegram.sendMessage(this.chatId, this.t(request.resumeFrom ? 'workflow_resumed' : 'workflow_started', { name: label })))
        }
      } else {
        await this.rest.sendMessage(sessionId, content, attachments, ...(messageKind ? [{ messageKind }] : []))
      }
      await done
    } finally {
      finish()
      // Everything queued is sent before the turn returns.
      let last
      do {
        last = out
        await last
      } while (last !== out)
    }
    // Like the web UI under the conversation: the criteria after a workflow,
    // the build buttons after a turn that left criteria to do.
    if (endedBy === 'done' && launch) await this._afterWorkflow(sessionId, launch.name ?? launch.label, taskCompleted, launchedAt)
    else if (endedBy === 'done') await this._offerBuild(sessionId)
  }

  /** Whether the buttons of this message were already removed (and forget it). */
  buttonsAlreadyRemoved(messageId) {
    return this._removedButtons.delete(messageId)
  }

  /** A permission request of the agent, with its buttons. */
  _showPathConfirmation(payload, sessionId) {
    const { callId, tool, paths, reason } = payload ?? {}
    const pathList = (paths ?? []).join(', ')
    const reasonText = this.t(PATH_REASON_KEYS[reason] ?? 'path_reason_outside')
    const text = `🔒 ${tool} · ${reasonText}\n${pathList}`
    if (!this.state.pendingPathConfirms) this.state.pendingPathConfirms = new Map()
    const rows = [
      [
        { text: this.t('path_allow'), callback_data: `path_confirm:${callId}:allow` },
        { text: this.t('path_deny'), callback_data: `path_confirm:${callId}:deny` },
      ],
    ]
    // Like the web UI: no blanket "allow everything" for git --no-verify,
    // which always needs its own explicit consent.
    if (reason !== 'git_no_verify') {
      rows.push([{ text: this.t('path_everything'), callback_data: `path_confirm:${callId}:always` }])
    }
    const keyboard = { inline_keyboard: rows }
    this.state.pendingPathConfirms.set(callId, { sessionId, messageId: null })
    this.logger.debug('telegram: _showPathConfirmation', { callId, tool, paths, reason })
    void this.telegram.sendMessage(this.chatId, text, { reply_markup: keyboard })
      .then((msg) => {
        const entry = this.state.pendingPathConfirms.get(callId)
        if (entry) entry.messageId = msg?.message_id ?? null
        this.logger.debug('telegram: _showPathConfirmation messageId set', { callId, messageId: msg?.message_id ?? null })
      })
      .catch((e) => this.logger.error('telegram: _showPathConfirmation sendMessage failed', { callId, error: e?.message }))
  }

  /** A question of the agent: buttons for a choice or a confirmation; a typed message also answers it. */
  _showQuestion(payload, sessionId) {
    const { callId, question, type, options } = payload ?? {}
    // Each question has its own token: a button answers its own question,
    // even when the agent asks another one meanwhile.
    const token = String(++this._questionSeq)
    const entry = { sessionId, callId, type, options: options ?? [], messageId: null, hasButtons: false }
    this.state.pendingQuestions.set(token, entry)
    let keyboard = null
    if (type === 'choice' && options?.length) {
      keyboard = { inline_keyboard: options.map((o, i) => [{ text: o.label ?? o.value, callback_data: `ask:${token}:${i}` }]) }
    } else if (type === 'confirm') {
      keyboard = { inline_keyboard: [[{ text: this.t('yes'), callback_data: `ask:${token}:yes` }, { text: this.t('no'), callback_data: `ask:${token}:no` }]] }
    }
    const text = keyboard ? `❓ ${question}` : `❓ ${question}\n\n${this.t('answer_by_message')}`
    entry.hasButtons = Boolean(keyboard)
    // The message id lets its buttons be removed however the question is settled.
    return Promise.resolve(this.telegram.sendMessage(this.chatId, text, keyboard ? { reply_markup: keyboard } : {}))
      .then((sent) => {
        entry.messageId = sent?.message_id ?? null
      })
      .catch((e) => this.logger.warn('telegram: question not sent', { callId, error: e?.message }))
  }

  /** Forget a question and remove its buttons (answered by typing, gone on OpenFox, turn over). */
  _forgetQuestion(token) {
    const entry = this.state.pendingQuestions.get(token)
    this.state.pendingQuestions.delete(token)
    if (!entry?.hasButtons || entry.messageId == null) return
    this._removedButtons.add(entry.messageId)
    void Promise.resolve(this.telegram.editMessageReplyMarkup?.(this.chatId, entry.messageId)).catch((e) =>
      this.logger.warn('telegram: question buttons not removed', { callId: entry.callId, error: e?.message }),
    )
  }

  // --- follow mode: turns started from OpenFox (the web UI) ---

  _followOn() {
    const v = typeof this.follow === 'function' ? this.follow() : this.follow
    return v === true || v === 'true'
  }

  /** Remember an event of a turn started here, so the watcher never sends it again. */
  _markSeen(payload) {
    for (const id of [payload?.messageId, payload?.callId]) {
      if (!id) continue
      this._seen.add(id)
      if (this._seen.size > 1000) this._seen.delete(this._seen.values().next().value)
    }
  }

  /**
   * Keep one subscription on the active session while follow mode is on, so
   * a turn started from OpenFox sends its answer, permission requests,
   * questions and changed files here. Called on every state change and
   * periodically (the setting changes live, a dropped socket reconnects).
   */
  syncWatcher() {
    const sessionId = this._followOn() ? this.state.sessionId : null
    const w = this._watcher
    if (w && w.alive && w.sessionId === sessionId) return
    this.closeWatcher()
    if (!sessionId) return
    const watcher = {
      sessionId,
      alive: true,
      busy: false,
      deltas: new Map(),
      fallback: new Map(),
      changes: new FileChanges(),
      sentIds: new Set(),
      headerSent: false,
      compactionDonePending: false,
      stopTyping: null,
      typingTimeout: null,
      out: Promise.resolve(),
      close: null,
    }
    watcher.close = this.subscribe(sessionId, (msg) => this._onWatchedEvent(watcher, msg), {
      onClose: () => {
        watcher.alive = false
        this._watcherTyping(watcher, false)
      },
    })
    this._watcher = watcher
    // Following a session whose turn already runs (plugin restarted mid-turn).
    void Promise.resolve(this.rest.getSessionDetail?.(sessionId))
      .then((detail) => {
        if (detail?.session?.isRunning && watcher.alive && this._watcher === watcher && !this._turn) this._watcherTyping(watcher, true)
      })
      .catch(() => {})
  }

  closeWatcher() {
    const w = this._watcher
    this._watcher = null
    if (!w) return
    w.alive = false
    this._watcherTyping(w, false)
    try {
      w.close?.()
    } catch {}
  }

  _onWatchedEvent(watcher, msg) {
    if (!watcher.alive || this._watcher !== watcher || !this._followOn()) return
    // A turn started here forwards its own events and shows its own "typing…".
    if (this._turn) {
      this._watcherTyping(watcher, false)
      return
    }
    const p = msg.payload ?? {}
    if ((p.messageId && this._seen.has(p.messageId)) || (p.callId && this._seen.has(p.callId))) return
    const sessionId = watcher.sessionId
    // "Typing…" while the OpenFox turn runs: from its start (or any sign of
    // work, e.g. the reasoning) to its end, a wait for the user or an error.
    if (msg.type === 'session.running') return this._watcherTyping(watcher, Boolean(p.isRunning))
    if (msg.type === 'chat.thinking') return this._watcherTyping(watcher, true)
    if (msg.type === 'chat.error' || (msg.type === 'chat.done' && p.agentType !== 'sub-agent')) this._watcherTyping(watcher, false)
    else if (['chat.delta', 'chat.tool_call', 'chat.tool_result', 'chat.tool_output'].includes(msg.type)) this._watcherTyping(watcher, true)
    // An OpenFox turn is running until its end (or an error).
    if (msg.type === 'chat.done' && p.agentType !== 'sub-agent' && p.reason !== 'waiting_for_user') watcher.busy = false
    else if (msg.type === 'chat.error') watcher.busy = false
    else if (msg.type === 'chat.delta' || msg.type === 'chat.tool_call') watcher.busy = true
    if (msg.type === 'chat.delta') {
      if (p.subAgentType) return
      watcher.deltas.set(p.messageId, (watcher.deltas.get(p.messageId) ?? '') + (p.content ?? ''))
    } else if (msg.type === 'chat.message') {
      const m = p.message
      const card = taskCompletedOf(p)
      if (card) {
        watcher.out = watcher.out
          .then(async () => {
            let detail = null
            try {
              detail = await this.rest.getSessionDetail(sessionId)
            } catch {}
            await this._sendWorkflowSummary(card, detail)
          })
          .catch(() => {})
      }
      if (m?.isCompactionSummary && !m.subAgentType) watcher.compactionDonePending = true
      if (m?.role === 'assistant' && typeof m.content === 'string') watcher.fallback.set(m.id ?? 'm', m.content)
    } else if (msg.type === 'chat.message_updated') {
      if (p.updates?.isStreaming === false) this._emitWatchedText(watcher, p.messageId)
    } else if (msg.type === 'chat.tool_call') {
      if (p.callId && p.tool) watcher.changes.onToolCall(p.callId, p.tool, p.args)
    } else if (msg.type === 'chat.tool_result') {
      watcher.changes.onToolResult(p.callId, Boolean(p.result?.success))
    } else if (msg.type === 'chat.path_confirmation') {
      this._showPathConfirmation(p, sessionId)
    } else if (msg.type === 'chat.ask_user') {
      this._showQuestion(p, sessionId)
    } else if (msg.type === 'chat.done') {
      if (p.agentType === 'sub-agent') return
      // The compaction turn's own chat.done: skip it, the real answer follows.
      if (watcher.compactionDonePending && p.reason === 'complete') {
        watcher.compactionDonePending = false
        return
      }
      if (!TURN_END_REASONS.has(p.reason)) return
      // The questions of this turn can no longer be answered.
      for (const [token, q] of this.state.pendingQuestions) {
        if (q.sessionId === sessionId) this._forgetQuestion(token)
      }
      // Remove the buttons from path confirmations of this session.
      if (this.state.pendingPathConfirms) {
        for (const [callId, entry] of this.state.pendingPathConfirms) {
          if (entry.sessionId === sessionId) {
            this.logger.debug('telegram: watcher chat.done removing path confirmation buttons', { callId, messageId: entry.messageId })
            if (entry.messageId) {
              void this.telegram.editMessageReplyMarkup(this.chatId, entry.messageId, { inline_keyboard: [] })
                .catch((e) => this.logger.warn('telegram: editMessageReplyMarkup failed', { callId, messageId: entry.messageId, error: e?.message }))
            }
            this.state.pendingPathConfirms.delete(callId)
          }
        }
      }
      this._emitWatchedText(watcher, p.messageId)
      const changes = watcher.changes
      watcher.changes = new FileChanges()
      watcher.headerSent = false
      watcher.deltas.clear()
      watcher.fallback.clear()
      watcher.out = watcher.out
        .then(() => this.sendTurnEnd('', changes))
        .then(() => this._offerBuild(sessionId))
        .catch(() => {})
    } else if (msg.type === 'chat.error') {
      void this.telegram.sendMessage(this.chatId, `⚠️ ${p.error ?? 'error'}`)
    }
  }

  /** A complete message of an OpenFox turn; the first one of the turn says where it comes from. */
  _emitWatchedText(watcher, messageId) {
    if (!messageId || watcher.sentIds.has(messageId)) return
    watcher.sentIds.add(messageId)
    if (watcher.sentIds.size > 1000) watcher.sentIds.delete(watcher.sentIds.values().next().value)
    const text = stripSystemReminders((watcher.deltas.get(messageId) ?? watcher.fallback.get(messageId) ?? '').trim())
    if (!text) return
    const body = watcher.headerSent ? text : `${this.t('from_openfox')}\n\n${text}`
    watcher.headerSent = true
    this.logger.info('telegram: forwarding an OpenFox message', { sessionId: watcher.sessionId, chars: text.length })
    watcher.out = watcher.out.then(() => this.sendFormatted(body)).catch(() => {})
  }

  /** The answer of a turn, then the summary of the files it changed. */
  async sendTurnEnd(text, changes) {
    if (text) await this.sendFormatted(text)
    const summary = changes?.summaryHtml(this._locale ?? 'fr')
    if (!summary) return
    try {
      await this.telegram.sendMessage(this.chatId, summary, { parse_mode: 'HTML' })
    } catch (e) {
      this.logger.warn('telegram: file summary rejected', { error: e?.message })
    }
  }

  /** Night mode of the active session, or null when there is none (or it cannot be read). */
  async _nightMode() {
    return (await this._sessionInfo())?.nightMode ?? null
  }

  /** Night mode and agent of the active session, or null when there is none (or it cannot be read). */
  async _sessionInfo() {
    if (!this.state.sessionId) return null
    try {
      const detail = await this.rest.getSessionDetail(this.state.sessionId)
      return { nightMode: Boolean(detail?.session?.nightMode), mode: detail?.session?.mode ?? null }
    } catch {
      return null
    }
  }

  async showStatus() {
    if (!this.state.sessionId) {
      return this.telegram.sendMessage(this.chatId, this.t('no_active_session'), { reply_markup: menuKeyboard({ session: false }) })
    }
    let detail
    try {
      detail = await this.rest.getSessionDetail(this.state.sessionId)
    } catch (e) {
      return this.telegram.sendMessage(this.chatId, this.t('status_unreadable', { err: e?.message ?? 'error' }))
    }
    const session = detail?.session ?? {}
    let project = session.projectId ?? this.state.projectId ?? '—'
    try {
      const projects = await this.rest.listProjects()
      project = projects.find((p) => p.id === (session.projectId ?? this.state.projectId))?.name ?? project
    } catch {}
    const ctx = detail?.contextState
    const fmt = (n) => Number(n).toLocaleString(this._locale === 'en' ? 'en-US' : 'fr-FR')
    const context =
      ctx?.maxTokens > 0
        ? `${fmt(ctx.currentTokens)} / ${fmt(ctx.maxTokens)} tokens (${Math.round((ctx.currentTokens / ctx.maxTokens) * 100)} %)`
        : '—'
    return this.telegram.sendMessage(
      this.chatId,
      this.t('status', {
        project,
        session: session.metadata?.title ?? session.title ?? this.state.sessionId,
        mode: session.mode ?? '—',
        model: session.providerModel ? modelLabel(session.providerModel) : this.t('model_default'),
        night: this.t(session.nightMode ? 'night_enabled' : 'night_disabled'),
        activity: this.t(session.isRunning ? 'status_running' : 'status_idle'),
        context,
      }),
    )
  }

  /**
   * Send the agent's markdown formatted. Chunked on the markdown (with room
   * for the tags), each chunk converted; a chunk Telegram cannot parse (e.g.
   * a code block split between two chunks) is sent as plain text instead.
   */
  async sendFormatted(markdown) {
    // Beyond two messages, a file reads better than a burst of messages.
    if (markdown.length > LONG_ANSWER_CHARS && this.telegram.sendDocument) {
      try {
        const caption = this.t('long_answer', { n: markdown.length.toLocaleString(this._locale === 'en' ? 'en-US' : 'fr-FR') })
        await this.telegram.sendDocument(this.chatId, 'reponse.md', markdown, caption)
        return
      } catch (e) {
        this.logger.warn('telegram: long answer file rejected, sent as messages', { error: e?.message })
      }
    }
    for (const { md, html } of htmlChunks(markdown)) {
      try {
        await this.telegram.sendMessage(this.chatId, html, { parse_mode: 'HTML' })
      } catch (e) {
        this.logger.warn('telegram: formatted message rejected, sent as plain text', { error: e?.message })
        await this.telegram.sendMessage(this.chatId, md, {})
      }
    }
  }

  /** Whether a plain message would go to OpenFox's queue (a turn is running on the active session). */
  isTurnRunning() {
    return Boolean(this._turn && this._turn.sessionId === this.state.sessionId)
  }

  /** Send a message while the agent works: OpenFox queues it, the running turn forwards its answer. */
  async queueText(text, attachments, { messageKind = null } = {}) {
    const turn = this._turn
    turn.queued++
    try {
      await this.rest.sendMessage(turn.sessionId, text, attachments, ...(messageKind ? [{ messageKind }] : []))
    } catch (e) {
      turn.queued--
      return this.telegram.sendMessage(this.chatId, `⚠️ ${e?.message ?? 'error'}`)
    }
    return this.telegram.sendMessage(this.chatId, this.t('queued'))
  }

  /** A photo or file, with its caption, sent to the active session as an attachment. */
  async handleFile(file, caption) {
    await this._ensureLocale()
    if (!this.state.sessionId) {
      return this.telegram.sendMessage(this.chatId, this.t('no_active_session'), { reply_markup: menuKeyboard({ session: false }) })
    }
    if (file.size > MAX_FILE_BYTES) return this.telegram.sendMessage(this.chatId, this.t('file_too_big'))
    let attachment
    try {
      const bytes = await this.telegram.downloadFile(file.fileId)
      attachment = toAttachment({ bytes, filename: file.filename, mimeType: file.mimeType })
    } catch (e) {
      this.logger.error('telegram: file download failed', { error: e?.message })
      return this.telegram.sendMessage(this.chatId, `⚠️ ${e?.message ?? 'error'}`)
    }
    if (!attachment) return this.telegram.sendMessage(this.chatId, this.t('file_unsupported'))
    const content = (caption ?? '').trim()
    if (this.isTurnRunning()) return this.queueText(content, [attachment])
    if (this._watcher?.busy && this._watcher.sessionId === this.state.sessionId) return this.queueOnWatched(content, [attachment])
    try {
      await this.runTurn(this.state.sessionId, content, [attachment])
    } catch (e) {
      await this.telegram.sendMessage(this.chatId, `⚠️ ${e.message}`)
    }
  }

  async queueOnWatched(text, attachments, { messageKind = null } = {}) {
    try {
      await this.rest.sendMessage(this.state.sessionId, text, attachments, ...(messageKind ? [{ messageKind }] : []))
    } catch (e) {
      return this.telegram.sendMessage(this.chatId, `⚠️ ${e?.message ?? 'error'}`)
    }
    return this.telegram.sendMessage(this.chatId, this.t('queued'))
  }

  /** Whether a typed message is the answer to the agent's question. */
  hasPendingQuestion() {
    return this.state.pendingQuestions.size > 0
  }

  /** Answer a question: the one of a button (its token), or else the last one asked. */
  async answerPendingQuestion(answer, token = [...this.state.pendingQuestions.keys()].at(-1), { typed = false } = {}) {
    const pq = this.state.pendingQuestions.get(token)
    if (!pq) return this.telegram.sendMessage(this.chatId, this.t('question_expired'))
    try {
      await this.rest.answerQuestion(pq.sessionId, pq.callId, answer)
      // Removed once OpenFox has the answer: a failed answer can be sent again.
      this._forgetQuestion(token)
      return this.telegram.sendMessage(this.chatId, this.t('answer_sent'))
    } catch (e) {
      // OpenFox no longer has the question (answered from the web UI, turn
      // over, restart): forget it, or every message would be taken as its
      // answer. A typed message then goes to the agent as a normal one.
      if (e?.status === 404 || e?.status === 410) {
        this._forgetQuestion(token)
        this.logger.warn('telegram: question no longer pending on OpenFox, dropped', { sessionId: pq.sessionId, callId: pq.callId })
        if (!typed) return this.telegram.sendMessage(this.chatId, this.t('question_expired'))
        await this.telegram.sendMessage(this.chatId, this.t('question_gone_forward'))
        return this.forwardText(answer)
      }
      this.logger.error('telegram: answerQuestion failed', { sessionId: pq.sessionId, callId: pq.callId, error: e?.message })
      return this.telegram.sendMessage(this.chatId, `⚠️ ${e?.message ?? 'error'}`)
    }
  }

  // --- state machine ---

  async handleText(raw) {
    try {
      return await this._handleText(raw)
    } finally {
      this._saveState()
    }
  }

  async _handleText(raw) {
    const typed = (raw ?? '').trim()
    if (!typed) return
    // A reply-keyboard key is its slash command.
    const t = KEYBOARD_COMMANDS[typed] ?? typed
    // The text asked for by "➕ Add": the criteria (a command cancels).
    if (this._criteriaInput) {
      const input = this._criteriaInput
      this._criteriaInput = null
      if (!isCommand(t)) {
        await this._ensureLocale()
        return this.addCriteria(input.sessionId, t)
      }
    }
    if (this.hasPendingQuestion() && !isCommand(t)) return this.answerPendingQuestion(t, undefined, { typed: true })
    await this._ensureLocale()

    // Stage continuations (text that completes a pending action). A workdir is
    // an absolute path that starts with "/", so we must not gate on a leading
    // "/"; only a *recognized* slash command interrupts the continuation.
    if (this.state.stage === 'new_project_name' && !isCommand(t)) {
      return this.newProject(t)
    }
    if (this.state.stage === 'new_session_title' && !isCommand(t)) {
      return this.confirmNewSession(t)
    }
    // An open model list: typed text filters its models. A command closes
    // it; on a provider list, typed text closes it (and cancels a creation).
    const picker = this._livePicker()
    if (picker && isCommand(t)) {
      this._closePicker()
    } else if (picker) {
      if (picker.providerIndex !== null) return this._filterModels(picker, t)
      this._closePicker()
      if (picker.purpose === 'create') return this.telegram.sendMessage(this.chatId, this.t('creation_cancelled'))
    }

    if (t === '/start' || t === '/reset') return this.showProjects()
    if (t === '/stop') {
      if (!this._abortTurn) return this.stopActiveSession()
      // Stop the agent on OpenFox, then stop waiting here. Waiting stops even
      // when the server call fails, and the failure is reported.
      const sessionId = this._turnSessionId
      let failure = null
      try {
        await this.rest.stopSession(sessionId)
      } catch (e) {
        failure = e?.message ?? 'error'
        this.logger.error('telegram: stopSession failed', { sessionId, error: failure })
      }
      this.stopTurn()
      if (failure) return this.telegram.sendMessage(this.chatId, `⚠️ ${failure}`)
      return this.telegram.sendMessage(this.chatId, this.t('stopped'))
    }
    if (t.startsWith('/new ')) return this.newProject(t.slice(5).trim())
    if (t === '/new') {
      this.state.stage = 'new_project_name'
      return this.telegram.sendMessage(this.chatId, this.t('send_project_name'))
    }
    if (t.startsWith('/new-session ')) return this.newSession(t.slice(13).trim())
    if (t === '/new-session') return this.newSession('')
    if (t.startsWith('/new_session ')) return this.newSession(t.slice(13).trim())
    if (t === '/new_session') return this.newSession('')
    if (t.startsWith('/sessions')) {
      const arg = t.slice(9).trim()
      if (arg) return this.showSessions(arg)
      // Without an explicit id, show the sessions of the selected project
      // (or fall back to the project picker when nothing is selected yet).
      if (this.state.projectId) return this.showSessions(this.state.projectId)
      return this.showProjects()
    }
    if (t.startsWith('/send ')) {
      const rest2 = t.slice(6).trim()
      const sp = rest2.search(/\s/)
      const sessionId = sp === -1 ? rest2 : rest2.slice(0, sp)
      const content = sp === -1 ? '' : rest2.slice(sp + 1).trim()
      if (!content) return this.telegram.sendMessage(this.chatId, this.t('usage_send'))
      this.state.sessionId = sessionId
      this.state.stage = 'active'
      return this.runTurn(sessionId, content)
    }
    if (t.startsWith('/continue ')) {
      const sessionId = t.slice('/continue '.length).trim()
      this.state.sessionId = sessionId
      this.state.stage = 'active'
      return this.telegram.sendMessage(this.chatId, this.t('session_active_continue', { id: sessionId }), {
        reply_markup: menuKeyboard(),
      })
    }
    if (t === '/agents') return this.showAgents()
    if (t === '/status') return this.showStatus()
    if (t === '/criteria') return this.showCriteria()
    if (t === '/model') {
      if (!this.state.sessionId) {
        return this.telegram.sendMessage(this.chatId, this.t('no_active_session'), { reply_markup: menuKeyboard({ session: false }) })
      }
      return this.showModels()
    }

    if (/^\d+$/.test(t)) return this.select(t)
    return this.forwardText(t)
  }

  /** Stop the agent on the active session when it works without a turn started here (web UI, expired turn). */
  async stopActiveSession() {
    if (!this.state.sessionId) return this.telegram.sendMessage(this.chatId, this.t('nothing_to_stop'))
    let running = false
    try {
      running = Boolean((await this.rest.getSessionDetail(this.state.sessionId))?.session?.isRunning)
    } catch (e) {
      return this.telegram.sendMessage(this.chatId, this.t('status_unreadable', { err: e?.message ?? 'error' }))
    }
    if (!running) return this.telegram.sendMessage(this.chatId, this.t('nothing_to_stop'))
    try {
      await this.rest.stopSession(this.state.sessionId)
    } catch (e) {
      return this.telegram.sendMessage(this.chatId, `⚠️ ${e?.message ?? 'error'}`)
    }
    return this.telegram.sendMessage(this.chatId, this.t('stopped'))
  }

  async showProjects() {
    const projects = await this.rest.listProjects()
    this._cachedProjects = projects
    this.state.projectId = null
    this.state.sessionId = null
    this.state.stage = 'pick_project'
    // A previous start left its header and list in the chat: remove them.
    await this.deleteProjectsMessages()
    // The session is closed: a short message brings the keys down to start
    // (the list below carries its own buttons, and a message holds one set).
    // It is deleted at once: the keys it set stay.
    const header = await this.telegram.sendMessage(this.chatId, this.t('projects_header'), {
      reply_markup: menuKeyboard({ session: false }),
    })
    this._projectsMessages.push(header?.message_id)
    await this.deleteProjectsMessages()
    if (projects.length === 0) {
      const keyboard = {
        inline_keyboard: [
          [{ text: this.t('btn_new_project'), callback_data: 'new_proj' }],
        ],
      }
      const list = await this.telegram.sendMessage(
        this.chatId,
        this.t('no_projects'),
        { reply_markup: keyboard },
      )
      this._projectsMessages.push(list?.message_id)
      return list
    }
    const keyboard = {
      inline_keyboard: [
        ...projects.map((p) => [{ text: p.name ?? p.id, callback_data: `proj:${p.id}` }]),
        [{ text: this.t('btn_new_project'), callback_data: 'new_proj' }],
      ],
    }
    // The keys under the input come with the session confirmation (a message
    // holds one set of buttons, so they used to need an extra "Menu :" message).
    const list = await this.telegram.sendMessage(
      this.chatId,
      this.t('choose_project'),
      { reply_markup: keyboard },
    )
    this._projectsMessages.push(list?.message_id)
    return list
  }

  /** Delete the "📂 Projets" header and the project list still in the chat. */
  async deleteProjectsMessages() {
    const ids = this._projectsMessages.filter((id) => id != null)
    this._projectsMessages = []
    for (const id of ids) {
      try {
        await this.telegram.deleteMessage?.(this.chatId, id)
      } catch (e) {
        this.logger.warn('telegram: could not delete a projects message', { error: e?.message })
      }
    }
  }

  async select(num) {
    const n = Number(num)
    if (this.state.stage === 'pick_project') {
      const p = this._cachedProjects[n - 1]
      if (!p) return this.telegram.sendMessage(this.chatId, this.t('no_project_n', { n }))
      await this.deleteProjectsMessages()
      this.state.projectId = p.id
      return this.showSessions(p.id)
    }
    if (this.state.stage === 'pick_session') {
      const s = this._cachedSessions[n - 1]
      if (!s) return this.telegram.sendMessage(this.chatId, this.t('no_session_n', { n }))
      this.state.sessionId = s.id
      this.state.stage = 'active'
      return this.showSessionActive(s.title ?? s.id)
    }
    return this.telegram.sendMessage(this.chatId, this.t('use_start_first'))
  }

  async showSessionActive(title) {
    let history = ''
    let nightNote = ''
    try {
      const detail = await this.rest.getSessionDetail(this.state.sessionId)
      if (detail?.session?.nightMode) nightNote = `\n\n${this.t('night_active_note')}`
      // The settings are numbers, or getters read on each use (live plugin settings).
      const setting = (v, fallback) => (typeof v === 'function' ? v() : v) || fallback
      const historyChars = setting(this.historyChars, HISTORY_MESSAGE_CHARS)
      const msgs = (detail?.messages ?? []).slice(-setting(this.historyCount, 6))
      if (msgs.length > 0) {
        history = msgs
          .map((m) => {
            const prefix = this.t(m.role === 'user' ? 'history_you' : 'history_agent')
            // A long message keeps its end (where the agent concludes), marked as cut.
            const full = stripSystemReminders(m.content ?? '').trim()
            const content = full.length > historyChars ? `…${full.slice(-historyChars)}` : full
            return content ? `${prefix} ${content}` : ''
          })
          .filter(Boolean)
          .join('\n\n')
      }
    } catch {}
    const base = this.t('session_active_select', { title }) + nightNote
    const text = history ? `${base}\n\n${this.t('history_header')}\n\n${history}` : base
    return this.telegram.sendMessage(this.chatId, text, { reply_markup: menuKeyboard() })
  }

  /** Name of a project, from the last projects list or else from OpenFox; its id when unknown. */
  async _projectName(projectId) {
    let project = this._cachedProjects.find((p) => p.id === projectId)
    if (!project) {
      try {
        project = (await this.rest.listProjects()).find((p) => p.id === projectId)
      } catch {}
    }
    return project?.name ?? projectId
  }

  async showSessions(projectId) {
    const sessions = await this.rest.listSessions(projectId)
    this._cachedSessions = sessions
    this.state.stage = 'pick_session'
    if (sessions.length === 0) {
      const keyboard = {
        inline_keyboard: [
          [{ text: this.t('btn_new_session'), callback_data: 'new_sess' }],
          [{ text: this.t('btn_back_projects'), callback_data: 'reset' }],
        ],
      }
      return this.telegram.sendMessage(
        this.chatId,
        this.t('no_sessions', { project: await this._projectName(projectId) }),
        { reply_markup: keyboard },
      )
    }
    const keyboard = {
      inline_keyboard: [
        ...sessions.map((s) => [{ text: s.title ?? s.id, callback_data: `sess:${s.id}` }]),
        [{ text: this.t('btn_new_session'), callback_data: 'new_sess' }],
        [{ text: this.t('btn_back_projects'), callback_data: 'reset' }],
      ],
    }
    return this.telegram.sendMessage(
      this.chatId,
      this.t('choose_session', { project: await this._projectName(projectId) }),
      { reply_markup: keyboard },
    )
  }

  async newProject(name) {
    if (!name) return this.telegram.sendMessage(this.chatId, this.t('usage_new'))
    if (!isValidProjectName(name)) return this.telegram.sendMessage(this.chatId, this.t('invalid_project_name'))
    try {
      const defaultWorkdir = await this.rest.getDefaultWorkdir()
      const workdir = defaultWorkdir ? `${defaultWorkdir}/${name}` : name
      const project = await this.rest.createProject(name, workdir)
      this.state.projectId = project.id
      await this.telegram.sendMessage(this.chatId, this.t('project_created', { name, id: project.id }))
      return this.showSessions(project.id)
    } catch (e) {
      this.state.stage = 'idle'
      return this.telegram.sendMessage(this.chatId, this.t('failed_create_project', { err: e.message }))
    }
  }

  async newSession(title) {
    if (!this.state.projectId) {
      return this.telegram.sendMessage(this.chatId, this.t('pick_project_first'))
    }
    if (!title) {
      this.state.stage = 'new_session_title'
      return this.telegram.sendMessage(this.chatId, this.t('send_session_title'))
    }
    // The model of the new session is chosen first (or the default one kept).
    const picker = this._openPicker({ purpose: 'create', title, projectId: this.state.projectId })
    let providers = []
    try {
      providers = await this._loadProviders(picker)
    } catch (e) {
      this.logger.warn('telegram: providers unavailable, session created with the default model', { error: e?.message })
    }
    if (providers.length === 0) {
      this._closePicker()
      return this._createSession(title, null, picker.projectId)
    }
    return this._showProviderList(picker)
  }

  /** Create the session, then set its model when one was chosen. */
  async _createSession(title, choice, projectId = this.state.projectId) {
    if (!projectId || !title) return this.telegram.sendMessage(this.chatId, this.t('pick_project_first'))
    try {
      const session = await this.rest.createSession(projectId, title)
      this.state.projectId = projectId
      this.state.sessionId = session.id
      this.state.stage = 'active'
      let warning = ''
      if (choice) {
        try {
          await this.rest.setSessionProvider(session.id, choice.providerId, choice.modelId)
        } catch (e) {
          this.logger.warn('telegram: setSessionProvider after create failed', { error: e?.message })
          warning = `\n\n${this.t('model_set_failed', { err: e?.message ?? 'error' })}`
        }
      }
      return this.telegram.sendMessage(this.chatId, this.t('session_created', { title: session.title ?? title, id: session.id }) + warning, {
        reply_markup: menuKeyboard(),
      })
    } catch (e) {
      return this.telegram.sendMessage(this.chatId, this.t('failed_create_session', { err: e.message }))
    }
  }

  async confirmNewSession(title) {
    this.state.stage = 'idle'
    return this.newSession(title)
  }

  async forwardText(text) {
    if (!this.state.sessionId) {
      // Also send the keyboard: Telegram keeps the last one the bot sent, and
      // an outdated one (after an update or a restart) lands here.
      return this.telegram.sendMessage(this.chatId, this.t('no_active_session'), { reply_markup: menuKeyboard({ session: false }) })
    }
    if (this.isTurnRunning()) return this.queueText(text)
    // An OpenFox turn runs (follow mode sees it): queue the message there,
    // the watcher forwards both answers.
    if (this._watcher?.busy && this._watcher.sessionId === this.state.sessionId) return this.queueOnWatched(text)
    try {
      await this.runTurn(this.state.sessionId, text)
    } catch (e) {
      await this.telegram.sendMessage(this.chatId, `⚠️ ${e.message}`)
    }
  }

  async showAgents() {
    // Only the agents one picks to drive a session; the others are sub-agents.
    const all = await this.rest.listAgents()
    const agents = SELECTABLE_AGENTS.map((id) => all.find((a) => a.id === id)).filter(Boolean)
    if (agents.length === 0) {
      return this.telegram.sendMessage(this.chatId, this.t('no_agents'))
    }
    const rows = agents.map((a) => [{ text: a.name, callback_data: `agent:${a.id}` }])
    const info = await this._sessionInfo()
    if (info) {
      const state = this.t(info.nightMode ? 'night_enabled' : 'night_disabled')
      rows.push([{ text: this.t('night_button', { state }), callback_data: 'night:toggle' }])
    }
    const keyboard = { inline_keyboard: rows }
    const current = info?.mode ? (all.find((a) => a.id === info.mode) ?? { id: info.mode }) : null
    return this.telegram.sendMessage(
      this.chatId,
      // A message needs a text: the current agent rather than a bare title.
      current ? this.t('agents_current', { name: current.name ?? current.id }) : this.t('agents_choose'),
      { reply_markup: keyboard },
    )
  }

  async setAgent(id) {
    if (!id) return this.telegram.sendMessage(this.chatId, this.t('usage_agent'))
    if (!this.state.sessionId) {
      return this.telegram.sendMessage(this.chatId, this.t('pick_session_first'))
    }
    try {
      const session = await this.rest.setSessionMode(this.state.sessionId, id)
      return this.telegram.sendMessage(
        this.chatId,
        this.t('agent_set', { mode: session.mode ?? id, title: session.metadata?.title ?? session.title ?? this.state.sessionId }),
      )
    } catch (e) {
      return this.telegram.sendMessage(this.chatId, this.t('failed_set_agent', { err: e.message }))
    }
  }

  // --- model lists (/model, and the model of a new session) ---
  // Buttons carry the list's generation and an index, never an id (ids can
  // be long, contain ":" and exceed Telegram's 64-byte callback data). A new
  // list replaces the previous one: buttons of an older list expire.

  _openPicker(fields) {
    this._pickerSeq = (this._pickerSeq ?? 0) + 1
    this._picker = { gen: this._pickerSeq, filter: '', page: 0, providerIndex: null, messageId: null, shownAt: Date.now(), ...fields }
    return this._picker
  }

  _closePicker() {
    this._picker = null
  }

  /** The open list, while it is recent enough to take typed text as a filter. */
  _livePicker() {
    const p = this._picker
    if (p && Date.now() - p.shownAt > MODEL_PICKER_TTL_MS) this._picker = null
    return this._picker
  }

  async _loadProviders(picker) {
    const { providers = [], activeProviderId = null } = (await this.rest.listProviders()) ?? {}
    picker.activeProviderId = activeProviderId
    picker.providers = providers
      .map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        models: (p.models ?? []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean),
      }))
      .filter((p) => p.models.length > 0)
    return picker.providers
  }

  /** Show the list in place of the previous one. */
  async _sendPicker(picker, text, rows) {
    const old = picker.messageId
    picker.messageId = null
    if (old != null) {
      try {
        await this.telegram.deleteMessage?.(this.chatId, old)
      } catch {}
    }
    picker.shownAt = Date.now()
    const sent = await this.telegram.sendMessage(this.chatId, text, { reply_markup: { inline_keyboard: rows } })
    picker.messageId = sent?.message_id ?? null
    return sent
  }

  _pickerFooter(picker) {
    const rows = []
    if (picker.purpose === 'create') rows.push([{ text: this.t('model_default_btn'), callback_data: `mdf:${picker.gen}` }])
    rows.push([{ text: this.t(picker.purpose === 'create' ? 'model_cancel_btn' : 'model_close_btn'), callback_data: `mcx:${picker.gen}` }])
    return rows
  }

  async _showProviderList(picker) {
    if (picker.providers.length === 1) {
      picker.providerIndex = 0
      return this._showModelPage(picker)
    }
    const rows = picker.providers.map((p, i) => [
      { text: `${p.id === picker.currentProviderId ? '✓ ' : ''}${p.name} (${p.models.length})`, callback_data: `prv:${picker.gen}:${i}` },
    ])
    const text = picker.purpose === 'create' ? this.t('model_for_new_session', { title: picker.title }) : this.t('provider_choose')
    return this._sendPicker(picker, text, [...rows, ...this._pickerFooter(picker)])
  }

  async _showModelPage(picker) {
    const provider = picker.providers[picker.providerIndex]
    const filter = picker.filter.toLowerCase()
    picker.visible = filter ? provider.models.filter((id) => id.toLowerCase().includes(filter)) : provider.models
    const pages = Math.max(1, Math.ceil(picker.visible.length / MODEL_PAGE_SIZE))
    picker.page = Math.min(Math.max(0, picker.page), pages - 1)
    const start = picker.page * MODEL_PAGE_SIZE
    const rows = picker.visible.slice(start, start + MODEL_PAGE_SIZE).map((id, j) => {
      const current = provider.id === picker.currentProviderId && id === picker.currentModel
      return [{ text: `${current ? '✓ ' : ''}${modelLabel(id)}`, callback_data: `mdl:${picker.gen}:${start + j}` }]
    })
    if (pages > 1) {
      const nav = []
      if (picker.page > 0) nav.push({ text: '◀️', callback_data: `mpg:${picker.gen}:${picker.page - 1}` })
      if (picker.page < pages - 1) nav.push({ text: '▶️', callback_data: `mpg:${picker.gen}:${picker.page + 1}` })
      rows.push(nav)
    }
    if (picker.providers.length > 1) rows.push([{ text: this.t('model_back_btn'), callback_data: `mpb:${picker.gen}` }])
    const lines = [`${provider.name} · ${this.t('model_choose')}`]
    lines.push(
      picker.visible.length === 0
        ? this.t('model_no_match', { filter: picker.filter })
        : this.t(picker.visible.length === 1 ? 'model_page_one' : 'model_page', { page: picker.page + 1, pages, count: picker.visible.length }),
    )
    lines.push(picker.filter ? this.t('model_filter_active', { filter: picker.filter }) : this.t('model_filter_hint'))
    return this._sendPicker(picker, lines.join('\n'), [...rows, ...this._pickerFooter(picker)])
  }

  _filterModels(picker, text) {
    picker.filter = text.trim()
    picker.page = 0
    return this._showModelPage(picker)
  }

  /** /model: the providers of OpenFox, then the models of the one chosen. */
  async showModels() {
    const sessionId = this.state.sessionId
    let session = null
    try {
      session = (await this.rest.getSessionDetail(sessionId))?.session ?? null
    } catch {}
    const picker = this._openPicker({
      purpose: 'set',
      sessionId,
      currentProviderId: session?.providerId ?? null,
      currentModel: session?.providerModel ?? null,
    })
    const providers = await this._loadProviders(picker)
    if (providers.length === 0) {
      this._closePicker()
      return this.telegram.sendMessage(this.chatId, this.t('no_models'))
    }
    return this._showProviderList(picker)
  }

  async _applyModel(sessionId, providerId, modelId) {
    try {
      const session = await this.rest.setSessionProvider(sessionId, providerId, modelId)
      return this.telegram.sendMessage(
        this.chatId,
        this.t('model_set', { model: modelLabel(modelId), title: session?.metadata?.title ?? session?.title ?? sessionId }),
      )
    } catch (e) {
      return this.telegram.sendMessage(this.chatId, this.t('model_set_failed', { err: e?.message ?? 'error' }))
    }
  }

  /** A click in a model list: prv/mpg/mpb navigate, mdl picks, mdf keeps the default, mcx closes. */
  async _onPickerCallback(data) {
    const [kind, gen, arg] = data.split(':')
    const picker = this._picker
    if (!picker || String(picker.gen) !== gen) return this.telegram.sendMessage(this.chatId, this.t('choice_expired'))
    // The clicked list is deleted by the runtime.
    picker.messageId = null
    if (kind === 'prv') {
      if (!picker.providers[Number(arg)]) return this.telegram.sendMessage(this.chatId, this.t('choice_expired'))
      Object.assign(picker, { providerIndex: Number(arg), page: 0, filter: '' })
      return this._showModelPage(picker)
    }
    if (kind === 'mpg') {
      picker.page = Number(arg)
      return this._showModelPage(picker)
    }
    if (kind === 'mpb') {
      Object.assign(picker, { providerIndex: null, page: 0, filter: '' })
      return this._showProviderList(picker)
    }
    if (kind === 'mdl') {
      const provider = picker.providers[picker.providerIndex]
      const modelId = picker.visible?.[Number(arg)]
      if (!provider || !modelId) return this.telegram.sendMessage(this.chatId, this.t('choice_expired'))
      this._closePicker()
      if (picker.purpose === 'create') return this._createSession(picker.title, { providerId: provider.id, modelId }, picker.projectId)
      return this._applyModel(picker.sessionId, provider.id, modelId)
    }
    if (kind === 'mdf' && picker.purpose === 'create') {
      this._closePicker()
      return this._createSession(picker.title, null, picker.projectId)
    }
    this._closePicker()
    return this.telegram.sendMessage(this.chatId, this.t(picker.purpose === 'create' ? 'creation_cancelled' : 'model_closed'))
  }

  // --- criteria and workflows (the web UI's criteria sidebar and "▶ Build & Verify") ---
  // Launch buttons carry their list's generation and an index (a workflow id
  // may not fit in 64 bytes); a new list expires the buttons of the older ones.

  /** The criteria to do when the web UI would offer the build: pending ones, outside a finished session or a running workflow. */
  _pendingForBuild(detail) {
    const session = detail?.session
    if (!session || session.phase === 'done') return []
    const status = detail.activeWorkflowExecution?.status
    if (status === 'running' || status === 'waiting') return []
    return (session.metadataEntries?.criteria ?? []).filter((c) => c.status === 'pending')
  }

  /** One launch button per workflow; a workflow with parameters needs the web UI's form. */
  async _launchRows(sessionId, detail) {
    let workflows = []
    try {
      workflows = (await this.rest.listWorkflows?.(detail?.session?.workdir)) ?? []
    } catch (e) {
      this.logger.warn('telegram: could not list the workflows', { sessionId, error: e?.message })
      return { rows: [], hidden: false }
    }
    const needsParams = (w) => (w.parameters ?? []).some((p) => p.required || p.position !== undefined)
    const launchable = workflows.filter((w) => !needsParams(w))
    const gen = (this._launchSeq = (this._launchSeq ?? 0) + 1)
    this._launchMenu = { gen, sessionId, workflows: launchable }
    const rows = launchable.map((w, i) => {
      const row = [{ text: `▶ ${w.name ?? w.id}`, callback_data: `wfl:${gen}:${i}` }]
      if (w.subGroups?.length) row.push({ text: '⋮', callback_data: `wfs:${gen}:${i}` })
      return row
    })
    return { rows, hidden: launchable.length < workflows.length }
  }

  /** The criteria as lines: an icon per state, within one Telegram message. */
  _criteriaLines(criteria) {
    const lines = []
    let length = 0
    for (const [i, c] of criteria.entries()) {
      let text = String(c.description ?? '').trim()
      if (text.length > CRITERION_TEXT_MAX) text = `${text.slice(0, CRITERION_TEXT_MAX)}…`
      const line = `${CRITERION_ICONS[c.status] ?? '•'} ${text}`
      if (length + line.length > CRITERIA_LIST_MAX_CHARS) {
        lines.push(this.t('criteria_more', { n: criteria.length - i }))
        break
      }
      lines.push(line)
      length += line.length + 1
    }
    return lines
  }

  /** /criteria: the session's criteria, an add button, the launch buttons while criteria are pending, the choices of a paused workflow. */
  async showCriteria(sessionId = this.state.sessionId) {
    if (!sessionId) {
      return this.telegram.sendMessage(this.chatId, this.t('no_active_session'), { reply_markup: menuKeyboard({ session: false }) })
    }
    let detail
    try {
      detail = await this.rest.getSessionDetail(sessionId)
    } catch (e) {
      return this.telegram.sendMessage(this.chatId, this.t('status_unreadable', { err: e?.message ?? 'error' }))
    }
    const criteria = detail?.session?.metadataEntries?.criteria ?? []
    const lines = []
    if (criteria.length === 0) lines.push(this.t('criteria_none'))
    else lines.push(this.t('criteria_header'), ...this._criteriaLines(criteria))
    const rows = [
      [{ text: this.t('btn_criteria_add'), callback_data: 'crit:add' }],
      [{ text: this.t('btn_criteria_agent'), callback_data: 'crit:agent' }],
    ]
    if (this._pendingForBuild(detail).length > 0) {
      const { rows: launch, hidden } = await this._launchRows(sessionId, detail)
      rows.push(...launch)
      if (hidden) lines.push('', this.t('workflow_params_hidden'))
    }
    rows.push([{ text: this.t('btn_criteria_close'), callback_data: 'crit:close' }])
    const sent = await this._sendCriteriaMessage(lines.join('\n'), rows)
    // A workflow paused on a step waiting for the user: its choices follow.
    if (this._waitingWorkflow(detail)) await this._offerContinue(sessionId, detail)
    return sent
  }

  /**
   * A criteria list or build offer. Its buttons replace those of the previous
   * one, which are removed (they have expired); the text of the old one stays.
   */
  async _sendCriteriaMessage(text, rows) {
    const old = this._criteriaMessageId
    this._criteriaMessageId = null
    if (old != null) {
      try {
        await this.telegram.editMessageReplyMarkup?.(this.chatId, old, { inline_keyboard: [] })
      } catch {}
    }
    const sent = await this.telegram.sendMessage(this.chatId, text, { reply_markup: { inline_keyboard: rows } })
    this._criteriaMessageId = sent?.message_id ?? null
    return sent
  }

  /** After a turn, as the web UI shows under the conversation: the build buttons while criteria are pending. */
  async _offerBuild(sessionId) {
    if (sessionId !== this.state.sessionId || !this.rest.getSessionDetail) return
    try {
      const detail = await this.rest.getSessionDetail(sessionId)
      if (this._waitingWorkflow(detail)) return await this._offerContinue(sessionId, detail)
      const pending = this._pendingForBuild(detail)
      if (pending.length === 0) return
      const { rows } = await this._launchRows(sessionId, detail)
      if (rows.length === 0) return
      const text = pending.length === 1 ? this.t('build_offer_one') : this.t('build_offer', { n: pending.length })
      const view = [{ text: this.t('btn_criteria_view'), callback_data: 'crit:view' }]
      const close = [{ text: this.t('btn_criteria_close'), callback_data: 'crit:close' }]
      await this._sendCriteriaMessage(text, [view, ...rows, close])
    } catch (e) {
      this.logger.warn('telegram: build offer failed', { sessionId, error: e?.message })
    }
  }

  /** Add criteria, one per line, numbered after the highest id (as the web UI does), then show the list. */
  async addCriteria(sessionId, text) {
    const added = text.split('\n').map((line) => line.trim()).filter(Boolean)
    if (added.length === 0) return
    try {
      const detail = await this.rest.getSessionDetail(sessionId)
      const current = (detail?.session?.metadataEntries?.criteria ?? []).map((c) => ({ ...c, id: String(c.id) }))
      const ids = current.map((c) => Number(c.id)).filter((n) => Number.isInteger(n) && n >= 0)
      const first = Math.max(-1, ...ids) + 1
      const fresh = added.map((description, i) => ({ id: String(first + i), description, status: 'pending' }))
      await this.rest.setCriteria(sessionId, [...current, ...fresh])
    } catch (e) {
      return this.telegram.sendMessage(this.chatId, this.t('criteria_add_failed', { err: e?.message ?? 'error' }))
    }
    await this.telegram.sendMessage(this.chatId, added.length === 1 ? this.t('criteria_added_one') : this.t('criteria_added', { n: added.length }))
    return this.showCriteria(sessionId)
  }

  /** The workflow paused on a step that waits for the user, while the agent does not run. */
  _waitingWorkflow(detail) {
    const exec = detail?.activeWorkflowExecution
    return exec?.status === 'waiting' && !detail?.session?.isRunning ? exec : null
  }

  /** The web UI's "Continue" buttons: one per choice of the paused step, or one to continue. */
  async _offerContinue(sessionId, detail) {
    const exec = this._waitingWorkflow(detail)
    if (!exec) return
    const gen = (this._launchSeq = (this._launchSeq ?? 0) + 1)
    this._continueMenu = { gen, sessionId, exec }
    const name = exec.workflowName ?? exec.workflowId
    const step = exec.currentStepName ?? exec.currentStepId ?? '…'
    const choices = exec.pendingChoices ?? []
    const rows = choices.length
      ? choices.map((c, i) => [{ text: c.label ?? c.id, callback_data: `wfc:${gen}:${i}` }])
      : [[{ text: this.t('btn_workflow_continue', { name, step }), callback_data: `wfc:${gen}:-` }]]
    return this.telegram.sendMessage(this.chatId, this.t('workflow_waiting', { name, step }), { reply_markup: { inline_keyboard: rows } })
  }

  /** The end of a workflow run: its paused step's choices, or its summary (as the web UI's card). */
  async _afterWorkflow(sessionId, name, taskCompleted, launchedAt = 0) {
    let detail = null
    try {
      detail = await this.rest.getSessionDetail(sessionId)
    } catch {}
    if (this._waitingWorkflow(detail)) return this._offerContinue(sessionId, detail)
    // OpenFox says the session stopped running before its card reaches the
    // WebSocket: the card is read from the session, where it already is
    // (a card from before this launch belongs to an earlier run).
    const card =
      taskCompleted ??
      (detail?.messages ?? [])
        .filter((m) => m?.messageKind === 'task-completed' && Date.parse(m.timestamp) >= launchedAt - CARD_CLOCK_SLACK_MS)
        .map((m) => taskCompletedOf({ message: m }))
        .filter(Boolean)
        .at(-1) ??
      null
    return this._sendWorkflowSummary(card, detail, name)
  }

  /** The summary of a finished workflow and the count of its criteria, without buttons (the list is /criteria). */
  async _sendWorkflowSummary(taskCompleted, detail, label = '') {
    const locale = this._locale ?? 'fr'
    const lines = [workflowSummary(taskCompleted, locale, label)]
    const count = criteriaCountLine(detail?.session?.metadataEntries?.criteria, locale)
    if (count) lines.push(count)
    try {
      await this.telegram.sendMessage(this.chatId, lines.join('\n'))
    } catch (e) {
      this.logger.warn('telegram: workflow summary failed', { error: e?.message })
    }
  }

  /** A "Continue" button: resume the paused workflow (with the chosen branch), as the web UI does. */
  async _onContinueCallback(data) {
    const [, gen, index] = data.split(':')
    const menu = this._continueMenu
    const exec = menu && String(menu.gen) === gen ? menu.exec : null
    const choice = exec && index !== '-' ? exec.pendingChoices?.[Number(index)] : null
    if (!exec || (index !== '-' && !choice)) return this.telegram.sendMessage(this.chatId, this.t('launch_expired'))
    this._continueMenu = null
    const name = exec.workflowName ?? exec.workflowId
    return this.startWorkflow(menu.sessionId, {
      workflowId: exec.workflowId,
      resumeFrom: exec.currentStepId,
      stepOutput: exec.stepOutput ?? {},
      ...(exec.params && Object.keys(exec.params).length > 0 ? { params: exec.params } : {}),
      ...(exec.subGroup ? { subGroup: exec.subGroup } : {}),
      ...(choice ? { userChoice: choice.id } : {}),
      name,
      label: choice ? `${name} · ${choice.label ?? choice.id}` : name,
    })
  }

  /**
   * Run a command of OpenFox on the active session, as the web UI's commands
   * menu does ("Add criteria": the agent adds the criteria it proposed). Its
   * agent first, if it has one; the turn is not awaited (a button's callback).
   */
  async runAgentCommand(commandId) {
    const sessionId = this.state.sessionId
    if (!sessionId) {
      return this.telegram.sendMessage(this.chatId, this.t('no_active_session'), { reply_markup: menuKeyboard({ session: false }) })
    }
    let command
    try {
      const detail = await this.rest.getSessionDetail(sessionId)
      command = await this.rest.getCommand(commandId, detail?.session?.workdir)
      if (!command?.prompt) throw new Error(`no command ${commandId}`)
      const agent = command.metadata?.agentMode
      if (agent && detail?.session?.mode !== agent) await this.rest.setSessionMode(sessionId, agent)
    } catch (e) {
      return this.telegram.sendMessage(this.chatId, this.t('command_failed', { err: e?.message ?? 'error' }))
    }
    const kind = { messageKind: 'command' }
    if (this.isTurnRunning()) return this.queueText(command.prompt, undefined, kind)
    if (this._watcher?.busy && this._watcher.sessionId === sessionId) return this.queueOnWatched(command.prompt, undefined, kind)
    await this.telegram.sendMessage(this.chatId, this.t('command_sent', { name: command.metadata?.name ?? commandId }))
    void this.runTurn(sessionId, command.prompt, undefined, kind).catch((e) =>
      this.telegram.sendMessage(this.chatId, `⚠️ ${e?.message ?? 'error'}`),
    )
  }

  /** A launch button: wfl starts a workflow, wfs shows its steps, wfg starts one step. */
  async _onLaunchCallback(data) {
    const [kind, gen, index, step] = data.split(':')
    const menu = this._launchMenu
    const workflow = menu && String(menu.gen) === gen ? menu.workflows[Number(index)] : null
    if (!workflow) return this.telegram.sendMessage(this.chatId, this.t('launch_expired'))
    const name = workflow.name ?? workflow.id
    if (kind === 'wfs') {
      const rows = [
        [{ text: this.t('btn_workflow_full'), callback_data: `wfl:${gen}:${index}` }],
        ...(workflow.subGroups ?? []).map((sg, k) => [{ text: sg, callback_data: `wfg:${gen}:${index}:${k}` }]),
        [{ text: this.t('btn_criteria_close'), callback_data: 'crit:close' }],
      ]
      return this.telegram.sendMessage(this.chatId, this.t('workflow_steps', { name }), { reply_markup: { inline_keyboard: rows } })
    }
    const subGroup = kind === 'wfg' ? workflow.subGroups?.[Number(step)] : undefined
    if (kind === 'wfg' && !subGroup) return this.telegram.sendMessage(this.chatId, this.t('launch_expired'))
    return this.startWorkflow(menu.sessionId, {
      workflowId: workflow.id,
      ...(subGroup ? { subGroup } : {}),
      scope: workflow.scope ?? 'auto',
      name,
      label: subGroup ? `${name} · ${subGroup}` : name,
    })
  }

  /** Start a workflow and follow it like a turn, without holding the bot (the callback returns at once). */
  async startWorkflow(sessionId, launch) {
    // A turn started here runs: OpenFox queues the workflow after it, this turn goes on.
    if (this._turn) {
      const { label, name, ...request } = launch
      try {
        const started = await this.rest.launchWorkflow(sessionId, request)
        return this.telegram.sendMessage(this.chatId, this.t(started?.status === 'queued' ? 'workflow_queued' : 'workflow_started', { name: label }))
      } catch (e) {
        return this.telegram.sendMessage(this.chatId, this.t('workflow_failed', { err: e?.message ?? 'error' }))
      }
    }
    void this.runTurn(sessionId, null, null, { launch }).catch((e) => {
      this.logger.warn('telegram: workflow launch failed', { sessionId, error: e?.message })
      return this.telegram.sendMessage(this.chatId, this.t('workflow_failed', { err: e?.message ?? 'error' }))
    })
  }

  async handleCallback(data) {
    try {
      return await this._handleCallback(data)
    } finally {
      this._saveState()
    }
  }

  async _handleCallback(data) {
    if (typeof data !== 'string') return
    await this._ensureLocale()
    if (data.startsWith('agent:')) {
      return this.setAgent(data.slice(6))
    }
    if (data.startsWith('proj:')) {
      await this.deleteProjectsMessages()
      const id = data.slice(5)
      this.state.projectId = id
      return this.showSessions(id)
    }
    if (data.startsWith('sess:')) {
      const id = data.slice(5)
      this.state.sessionId = id
      this.state.stage = 'active'
      const s = this._cachedSessions.find((x) => x.id === id)
      const title = s?.title ?? id
      return this.showSessionActive(title)
    }
    if (data === 'new_proj') {
      await this.deleteProjectsMessages()
      this.state.stage = 'new_project_name'
      return this.telegram.sendMessage(this.chatId, this.t('send_project_name'))
    }
    if (data === 'new_sess') {
      if (!this.state.projectId) {
        return this.telegram.sendMessage(this.chatId, this.t('pick_project_first_cb'))
      }
      this.state.stage = 'new_session_title'
      return this.telegram.sendMessage(this.chatId, this.t('send_session_title_cb'))
    }
    if (data === 'reset') {
      return this.showProjects()
    }
    if (data === 'night:toggle') {
      if (!this.state.sessionId) return this.telegram.sendMessage(this.chatId, this.t('pick_session_first'))
      const current = await this._nightMode()
      // Unknown state: do not guess (it would turn night mode on).
      if (current === null) return this.telegram.sendMessage(this.chatId, this.t('night_unreadable'))
      try {
        await this.rest.setNightMode(this.state.sessionId, !current)
        return this.telegram.sendMessage(this.chatId, this.t(current ? 'night_off' : 'night_on'))
      } catch (e) {
        return this.telegram.sendMessage(this.chatId, `⚠️ ${e?.message ?? 'error'}`)
      }
    }
    if (/^(prv|mdl|mpg|mpb|mdf|mcx):/.test(data)) return this._onPickerCallback(data)
    if (/^(wfl|wfs|wfg):/.test(data)) return this._onLaunchCallback(data)
    if (data.startsWith('wfc:')) return this._onContinueCallback(data)
    // Cancel: the runtime removes the buttons, the criteria stay in the chat.
    if (data === 'crit:close') return
    if (data === 'crit:view') return this.showCriteria()
    if (data === 'crit:agent') return this.runAgentCommand('add-criteria')
    if (data === 'crit:add') {
      if (!this.state.sessionId) {
        return this.telegram.sendMessage(this.chatId, this.t('no_active_session'), { reply_markup: menuKeyboard({ session: false }) })
      }
      this._criteriaInput = { sessionId: this.state.sessionId }
      return this.telegram.sendMessage(this.chatId, this.t('criteria_add_prompt'))
    }
    if (data.startsWith('ask:')) {
      // ask:<token>:<choice>
      const [, token, choice] = data.split(':')
      const pq = this.state.pendingQuestions.get(token)
      if (!pq || choice === undefined) return this.telegram.sendMessage(this.chatId, this.t('question_expired'))
      const answer = pq.type === 'confirm' ? choice : pq.options[Number(choice)]?.value
      if (answer === undefined) return this.telegram.sendMessage(this.chatId, this.t('question_expired'))
      return this.answerPendingQuestion(answer, token)
    }
    if (data.startsWith('path_confirm:')) {
      const idx = data.lastIndexOf(':')
      const callId = data.slice(13, idx)
      const action = data.slice(idx + 1)
      const entry = this.state.pendingPathConfirms?.get(callId)
      const sessionId = entry?.sessionId ?? this.state.sessionId
      this.state.pendingPathConfirms?.delete(callId)
      this.logger.debug('telegram: path_confirm callback', { data, sessionId, callId, action, entryMessageId: entry?.messageId ?? null })
      // Remove the buttons immediately: the confirmation is being resolved,
      // whether from Telegram or from OpenFox.
      if (entry?.messageId) {
        this._removedButtons.add(entry.messageId)
        void this.telegram.editMessageReplyMarkup(this.chatId, entry.messageId, { inline_keyboard: [] })
          .then(() => this.logger.debug('telegram: buttons removed via handleCallback', { callId, messageId: entry.messageId }))
          .catch((err) => this.logger.warn('telegram: editMessageReplyMarkup failed in handleCallback', { callId, messageId: entry.messageId, error: err?.message }))
      } else {
        this.logger.debug('telegram: no messageId to remove buttons in handleCallback', { callId })
      }
      if (!sessionId) {
        return this.telegram.sendMessage(this.chatId, this.t('no_active_session'), { reply_markup: menuKeyboard({ session: false }) })
      }
      const approved = action === 'allow' || action === 'always'
      try {
        if (action === 'always') {
          // Like the web UI's "Allow everything": switch the session to
          // dangerous mode; the server then approves the pending requests
          // (this one included). If the switch fails, allow this one only.
          try {
            await this.rest.setDangerLevel(sessionId, 'dangerous')
            this.logger.debug('telegram: setDangerLevel dangerous', { sessionId })
            return this.telegram.sendMessage(this.chatId, this.t('path_everything_allowed'))
          } catch (e) {
            this.logger.error('telegram: setDangerLevel failed', { sessionId, error: e?.message })
            await this.rest.confirmPath(sessionId, callId, true, false)
            return this.telegram.sendMessage(this.chatId, this.t('path_danger_level_failed'))
          }
        }
        const result = await this.rest.confirmPath(sessionId, callId, approved, false)
        this.logger.debug('telegram: confirmPath result', { sessionId, callId, approved, result })
        return this.telegram.sendMessage(this.chatId, this.t(approved ? 'path_allowed' : 'path_denied'))
      } catch (e) {
        this.logger.error('telegram: confirmPath failed', { sessionId, callId, error: e?.message })
        return this.telegram.sendMessage(this.chatId, `⚠️ ${e?.message ?? 'error'}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket subscription — opens a WS to the OpenFox server, sends
// `session.load`, and forwards chat events to `onEvent`. Returns a cleanup.
// ---------------------------------------------------------------------------
export function wsUrl(baseUrl) {
  const u = new URL(baseUrl ?? DEFAULT_BASE_URL)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/ws'
  return u.toString()
}

export function createWsSubscribe(baseUrl, logger = noopLogger) {
  const url = wsUrl(baseUrl)
  return (sessionId, onEvent, { onClose, onOpen } = {}) => {
    let ws
    let closed = false
    const cleanup = () => {
      if (closed) return
      closed = true
      try {
        ws?.close()
      } catch {}
    }
    try {
      ws = new WebSocket(url)
    } catch (e) {
      logger.error('WebSocket construction failed', { error: e?.message })
      return () => {}
    }
    ws.addEventListener('open', () => {
      if (closed) return
      try {
        ws.send(JSON.stringify({ id: 'load', type: 'session.load', payload: { sessionId } }))
      } catch {}
      onOpen?.()
    })
    ws.addEventListener('message', (ev) => {
      if (closed) return
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      // OpenFox sends every session's events to every client: keep this session's.
      if (msg?.sessionId && msg.sessionId !== sessionId) return
      // The reasoning only says the agent is working: forwarded without its
      // content, so it can never leak to Telegram.
      if (msg?.type === 'chat.thinking') return onEvent({ type: 'chat.thinking', payload: {} })
      // A command's output, likewise: activity only (a long command prints as it runs).
      if (msg?.type === 'chat.tool_output') return onEvent({ type: 'chat.tool_output', payload: {} })
      // Forward only the events the turn runner and the follow mode use.
      if (
        msg &&
        (msg.type === 'chat.delta' ||
          msg.type === 'chat.done' ||
          msg.type === 'chat.error' ||
          msg.type === 'chat.message' ||
          msg.type === 'chat.message_updated' ||
          msg.type === 'chat.tool_call' ||
          msg.type === 'chat.tool_result' ||
          msg.type === 'chat.path_confirmation' ||
          msg.type === 'chat.ask_user' ||
          msg.type === 'session.running')
      ) {
        onEvent(msg)
      }
    })
    ws.addEventListener('close', () => {
      const dropped = !closed
      closed = true
      // Closed by the server (restart, network), not by cleanup.
      if (dropped) onClose?.()
    })
    return cleanup
  }
}

// Register the bot's command menu with Telegram so the commands appear in the
// native "/" autocomplete. Non-fatal: a failure here must not stop the bot.
export async function registerBotCommands(telegram, logger = noopLogger) {
  for (const [commands, opts] of [[BOT_COMMANDS, {}], [BOT_COMMANDS_EN, { languageCode: 'en' }]]) {
    try {
      await telegram.setMyCommands(commands, opts)
    } catch (e) {
      logger.warn('setMyCommands failed', { error: e?.message })
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime — owns the Telegram long-polling loop and per-chat conversations.
// ---------------------------------------------------------------------------
export function createRuntime({ telegram, rest, subscribe, logger, auth = {}, historyCount, historyChars, storage, follow }) {
  const conversations = new Map()
  let stopped = false
  // What the status panel shows: the Telegram connection and the bot's name.
  const health = { connection: 'starting', lastError: null, bot: null }
  let followTimer = null
  // A turn is awaited until the agent is done, which can take minutes (and,
  // during a path confirmation, waits for a click). Text is therefore handled
  // off the polling loop, one message after the other per chat, so the loop
  // keeps reading Telegram: a button click or /stop during a turn is handled
  // at once instead of after the turn (when the confirmation was gone).
  const chatQueues = new Map()

  function runInOrder(chatId, task) {
    const next = (chatQueues.get(chatId) ?? Promise.resolve()).then(task).catch(() => {})
    chatQueues.set(chatId, next)
    return next
  }

  function getConversation(chatId) {
    let conv = conversations.get(chatId)
    if (!conv) {
      conv = new Conversation({ chatId, telegram, rest, subscribe, logger, historyCount, historyChars, storage, follow })
      conversations.set(chatId, conv)
    }
    return conv
  }

  // Only the configured Telegram user ID drives the bot: it drives OpenFox,
  // whose agent runs commands on the machine. Without an ID nobody does
  // (bot names are public), and the warning gives the sender ID to set.
  function isAuthorized(senderId) {
    if (!auth.userId) {
      logger.warn('telegram: no authorized user ID set, update ignored (set authorizedUserId)', { senderId })
      return false
    }
    if (senderId !== auth.userId) {
      logger.info('telegram: update from an unauthorized user ignored', { senderId, authUserId: auth.userId })
      return false
    }
    return true
  }

  async function dispatch(update) {
    const cb = update?.callback_query
    if (cb) {
      const senderId = cb.from?.id
      logger.info('telegram: callback received', { data: cb.data, senderId, authUserId: auth.userId })
      if (!isAuthorized(senderId)) return
      const chatId = cb.message?.chat?.id
      if (chatId == null) return
      try {
        await telegram.answerCallbackQuery(cb.id)
      } catch {}
      const conv = getConversation(chatId)
      try {
        await conv.handleCallback(cb.data)
      } catch (e) {
        logger.error('handleCallback failed', { chatId, error: e?.message })
      }
      // Buttons answer once: remove them so they cannot be clicked again (a
      // second confirmation answer gets "No pending path confirmation", an old
      // project or session list would switch back).
      // A list (projects, sessions, agents) is deleted once a choice is made:
      // the next message says what was chosen.
      if (cb.message?.message_id != null && isListChoice(cb.data)) {
        try {
          await telegram.deleteMessage(chatId, cb.message.message_id)
          return
        } catch (e) {
          logger.warn('telegram: could not delete the list', { chatId, error: e?.message })
        }
      }
      if (cb.message?.message_id != null && !conv.buttonsAlreadyRemoved(cb.message.message_id)) {
        try {
          await telegram.editMessageReplyMarkup(chatId, cb.message.message_id)
        } catch (e) {
          logger.warn('telegram: could not remove the confirmation buttons', { chatId, error: e?.message })
        }
      }
      return
    }
    const msg = update?.message
    if (!msg) return
    const chatId = msg.chat?.id
    const text = msg.text
    const user = msg.from
    const file = fileOf(msg)
    if (chatId != null && text == null && file) {
      if (!isAuthorized(user?.id)) return
      const conv = getConversation(chatId)
      logger.info('telegram: incoming file', { chatId, mimeType: file.mimeType, size: file.size })
      const handle = async () => {
        try {
          await conv.handleFile(file, msg.caption)
        } catch (e) {
          logger.error('handleFile failed', { chatId, error: e?.message })
        }
      }
      if (conv.isTurnRunning()) void handle()
      else void runInOrder(chatId, handle)
      return
    }
    if (chatId == null || text == null) return
    if (!isAuthorized(user?.id)) return
    const conv = getConversation(chatId)
    logger.info('telegram: incoming message', { chatId, text: String(text).slice(0, 80) })
    const handle = async () => {
      try {
        await conv.handleText(text)
      } catch (e) {
        logger.error('handleText failed', { chatId, error: e?.message })
        try {
          await telegram.sendMessage(chatId, `⚠️ ${e?.message}`)
        } catch {}
      }
    }
    // /stop must reach the running turn, not wait behind it.
    const trimmed = String(text).trim()
    // /stop and the answer to the agent's question must reach the running
    // turn, not wait behind it.
    // A plain message during a turn goes to OpenFox's queue at once, as in
    // the web UI; commands still wait for the turn.
    const plainDuringTurn = conv.isTurnRunning() && !KEYBOARD_COMMANDS[trimmed] && !isCommand(trimmed)
    // /status and /agents only read (or offer a list): no need to wait either.
    const command = KEYBOARD_COMMANDS[trimmed] ?? trimmed
    const immediate = command === '/stop' || command === '/status' || command === '/agents' || command === '/criteria'
    if (immediate || conv.hasPendingQuestion() || plainDuringTurn) void handle()
    else void runInOrder(chatId, handle)
  }

  async function pollLoop() {
    let offset
    while (!stopped) {
      try {
        logger.debug('telegram: polling for updates', { offset })
        const updates = await telegram.getUpdates(offset, POLL_TIMEOUT_SEC)
        health.connection = 'ok'
        health.lastError = null
        logger.debug('telegram: got updates', { count: updates.length })
        for (const u of updates) {
          offset = u.update_id + 1
          await dispatch(u)
        }
      } catch (e) {
        if (stopped) break
        health.connection = e?.conflict ? 'conflict' : 'error'
        health.lastError = e?.message ?? 'error'
        if (e?.conflict) {
          logger.error('Telegram 409: bot token is in use by another process. Stopping poller.')
          stopped = true
          break
        }
        const backoff = e?.retryAfterMs ? e.retryAfterMs + 1000 : 3000
        logger.warn('Telegram polling error, backing off', { error: e?.message, backoffMs: backoff })
        await sleep(backoff)
      }
    }
  }

  return {
    start() {
      if (stopped) return
      void registerBotCommands(telegram, logger)
      void Promise.resolve(telegram.getMe?.())
        .then((me) => {
          health.bot = me?.username ?? null
          // The bot answered: Telegram is reachable with this token.
          if (me && health.connection === 'starting') health.connection = 'ok'
        })
        .catch(() => {})
      // Follow mode: watch the authorized user's session (a private chat's id
      // is the user's id) from the start, then keep the watchers in line with
      // the setting and reconnect dropped ones.
      if (auth.userId) getConversation(auth.userId).syncWatcher()
      followTimer = setInterval(() => {
        for (const conv of conversations.values()) conv.syncWatcher()
      }, FOLLOW_SYNC_MS)
      followTimer.unref?.()
      pollLoop()
    },
    /** The connection, the bot's name and each chat's session, for the status panel. */
    status() {
      // A private chat's id is the user's id: show the authorized user's chat
      // (its session is restored from storage) even before a new message.
      const userId = auth.userId
      if (userId && !conversations.has(userId)) getConversation(userId)
      return {
        ...health,
        chats: [...conversations.values()].map((c) => ({
          chatId: c.chatId,
          projectId: c.state.projectId ?? null,
          sessionId: c.state.sessionId ?? null,
          running: Boolean(c._abortTurn),
        })),
      }
    },
    stop() {
      stopped = true
      clearInterval(followTimer)
      telegram.abort()
      for (const conv of conversations.values()) {
        try {
          conv.closeWatcher()
          conv.stopTurn()
          conv.abort()
        } catch {}
      }
    },
  }
}

// ---------------------------------------------------------------------------
// FileChanges: the files a turn wrote or edited (successful calls only), with
// the lines added and removed by the edits, summed up after the answer.
// ---------------------------------------------------------------------------
const lineCount = (text) => {
  const t = String(text ?? '')
  if (!t) return 0
  return t.split('\n').length - (t.endsWith('\n') ? 1 : 0)
}

export class FileChanges {
  constructor() {
    this._pending = new Map()
    this._files = new Map()
  }

  onToolCall(callId, tool, args) {
    if (!args?.path) return
    if (tool === 'edit_file') this._pending.set(callId, { path: args.path, added: lineCount(args.new_string), removed: lineCount(args.old_string) })
    else if (tool === 'write_file') this._pending.set(callId, { path: args.path, added: lineCount(args.content), removed: 0 })
  }

  onToolResult(callId, success) {
    const change = this._pending.get(callId)
    this._pending.delete(callId)
    if (!change || !success) return
    const file = this._files.get(change.path) ?? { path: change.path, added: 0, removed: 0 }
    file.added += change.added
    file.removed += change.removed
    this._files.set(change.path, file)
  }

  files() {
    return [...this._files.values()]
  }

  /** "📝 N files changed (+a −r)" and the list in an expandable quote, or null. */
  summaryHtml(locale) {
    const files = this.files()
    if (files.length === 0) return null
    const added = files.reduce((n, f) => n + f.added, 0)
    const removed = files.reduce((n, f) => n + f.removed, 0)
    const n = files.length
    const head = locale === 'en'
      ? `📝 ${n} file${n > 1 ? 's' : ''} changed (+${added} −${removed})`
      : `📝 ${n} fichier${n > 1 ? 's' : ''} modifié${n > 1 ? 's' : ''} (+${added} −${removed})`
    const list = files.map((f) => `${f.path}  +${f.added} −${f.removed}`).join('\n')
    return `${head}\n<blockquote expandable>${escapeHtml(list)}</blockquote>`
  }
}

// ---------------------------------------------------------------------------
// OpenFox's address. The plugin runs inside the server it drives, so the
// server's own port is known: the --port it was started with, OPENFOX_PORT,
// or the port of its config.json; 10369 (OpenFox's default) otherwise. The
// openfoxUrl setting overrides it.
// ---------------------------------------------------------------------------
export function resolveBaseUrl({ argv = [], env = {}, configPort = null, override = '' }) {
  if (override && String(override).trim()) return String(override).trim().replace(/\/$/, '')
  let port = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) port = argv[i + 1]
    else if (argv[i]?.startsWith('--port=')) port = argv[i].slice(7)
  }
  port = port ?? env.OPENFOX_PORT ?? configPort ?? 10369
  return `http://127.0.0.1:${port}`
}

// The port in OpenFox's config.json: the config directory holds the plugins
// directory this file is installed in ({configDir}/plugins/<name>/src or
// {configDir}/plugins/node_modules/<name>/src).
export function configFilePort(startDir = dirname(fileURLToPath(import.meta.url))) {
  let dir = startDir
  for (let i = 0; i < 6; i++) {
    const parent = dirname(dir)
    if (basename(dir) === 'plugins') {
      try {
        const port = JSON.parse(readFileSync(join(parent, 'config.json'), 'utf8'))?.server?.port
        return Number.isInteger(port) ? port : null
      } catch {
        return null
      }
    }
    if (parent === dir) break
    dir = parent
  }
  return null
}

// ---------------------------------------------------------------------------
// Status panel: opened from the plugin's row in the plugins menu.
// ---------------------------------------------------------------------------
const L = (en, fr) => ({ en, fr })

const CONNECTION_BADGES = {
  ok: { label: L('Connected', 'Connecté'), tone: 'success' },
  starting: { label: L('Connecting…', 'Connexion…'), tone: 'info' },
  error: { label: L('Error', 'Erreur'), tone: 'warning' },
  conflict: { label: L('Stopped', 'Arrêté'), tone: 'danger' },
  off: { label: L('Not started', 'Non démarré'), tone: 'neutral' },
}

export function statusPanelContent({ tokenSet, authorizedUserId, bot = null, connection = 'off', lastError = null, chats = [] }) {
  const nodes = []
  const warn = (tone, title, text) => nodes.push({ type: 'callout', tone, icon: 'warning', title, text })
  if (!tokenSet) {
    warn('warning', L('No bot token', 'Aucun jeton de bot'), L(
      'Set the bot token in the settings, then restart the plugin (disable then enable it).',
      'Aucun jeton : renseignez-le dans les paramètres, puis redémarrez le plugin (désactiver puis réactiver).',
    ))
  }
  if (connection === 'conflict') {
    warn('danger', L('Bot stopped', 'Bot arrêté'), L(
      'This bot token is used by another program. Stop it, then restart the plugin.',
      'Ce jeton est utilisé par un autre programme. Arrêtez-le, puis redémarrez le plugin.',
    ))
  } else if (connection === 'error') {
    warn('warning', L('Telegram unreachable', 'Telegram injoignable'), L(`Retrying. Last error: ${lastError}`, `Nouvel essai en cours. Dernière erreur : ${lastError}`))
  }
  if (!authorizedUserId) {
    warn('warning', L('No authorized user ID', 'Aucun ID autorisé'), L(
      'The bot answers nobody until an authorized user ID is set.',
      "Le bot ne répond à personne tant qu'aucun ID utilisateur autorisé n'est renseigné.",
    ))
  }
  const badge = CONNECTION_BADGES[tokenSet ? connection : 'off'] ?? CONNECTION_BADGES.off
  nodes.push({
    type: 'card',
    title: L('Bot', 'Bot'),
    children: [
      {
        type: 'stack',
        direction: 'row',
        justify: 'between',
        align: 'center',
        children: [{ type: 'text', text: L('Telegram connection', 'Connexion Telegram') }, { type: 'badge', ...badge }],
      },
      {
        type: 'keyValue',
        items: [
          { key: L('Bot', 'Bot'), value: bot ? `@${bot}` : '—' },
          { key: L('Authorized user ID', 'ID utilisateur autorisé'), value: authorizedUserId ? String(authorizedUserId) : '—' },
        ],
      },
    ],
  })
  const rows = chats.flatMap((chat, i) => [
    ...(i > 0 ? [{ type: 'divider' }] : []),
    {
      type: 'stack',
      direction: 'row',
      justify: 'between',
      align: 'center',
      children: [
        { type: 'text', text: L(chat.session ?? 'No active session', chat.session ?? 'Aucune session active') },
        chat.running
          ? { type: 'badge', label: L('Working', 'Au travail'), tone: 'info' }
          : { type: 'badge', label: L('Idle', 'En attente'), tone: 'neutral' },
      ],
    },
    {
      type: 'keyValue',
      items: [
        { key: L('Project', 'Projet'), value: chat.project ?? '—' },
        { key: L('Agent', 'Agent'), value: chat.mode ?? '—' },
      ],
    },
  ])
  nodes.push({
    type: 'card',
    title: L('Conversations', 'Conversations'),
    children: rows.length
      ? rows
      : [{ type: 'text', muted: true, text: L('No Telegram conversation since the plugin started.', 'Aucune conversation Telegram depuis le démarrage du plugin.') }],
  })
  return nodes
}

const STATUS_FOOTER = [
  {
    type: 'stack',
    direction: 'row',
    justify: 'end',
    gap: 'sm',
    children: [
      { type: 'button', label: L('Settings', 'Paramètres'), icon: 'gear', onActivate: { kind: 'openSettings', tab: 'plugins' } },
      { type: 'button', label: L('Refresh', 'Actualiser'), icon: 'refresh', variant: 'primary', onActivate: { kind: 'rpc', method: 'refreshStatus' } },
    ],
  },
]

// ---------------------------------------------------------------------------
// Public plugin surface.
// ---------------------------------------------------------------------------
let runtime = null

export function register(registry) {
  // Stop the previous runtime via globalThis: on a cache-bust re-import this
  // module is a fresh ESM instance whose module-scoped `runtime` is undefined,
  // so only the shared globalThis reference can reach the old runtime.
  const oldRuntime = globalThis[RUNTIME_KEY]
  oldRuntime?.stop()
  globalThis[RUNTIME_KEY] = null
  runtime = null
  const { context } = registry

  registry.registerSettings({
    fields: [
      {
        key: 'botToken',
        type: 'password',
        label: { en: 'Bot token', fr: 'Jeton du bot' },
        description: {
          en: 'Telegram bot token from @BotFather. Restart the plugin (disable then enable it) or OpenFox to apply a new token; the other settings apply at once.',
          fr: "Jeton du bot Telegram obtenu auprès de @BotFather. Pour appliquer un nouveau jeton, redémarrez le plugin (désactiver puis réactiver) ou OpenFox ; les autres paramètres s'appliquent tout de suite.",
        },
        secret: true,
      },
      {
        key: 'authorizedUserId',
        type: 'text',
        label: { en: 'Authorized user ID', fr: 'ID utilisateur autorisé' },
        description: {
          en: 'Required. Only this Telegram user ID may drive the bot; without it the bot answers nobody. Find yours with @userinfobot.',
          fr: "Obligatoire. Seul cet ID Telegram peut piloter le bot ; sans lui, le bot ne répond à personne. Pour connaître le vôtre : @userinfobot.",
        },
      },
      {
        key: 'openfoxUrl',
        type: 'text',
        label: { en: 'OpenFox URL', fr: "URL d'OpenFox" },
        description: {
          en: 'Leave empty: the plugin finds the port of the OpenFox it runs in automatically. Restart the plugin to apply a change.',
          fr: "Laisser vide : le plugin trouve automatiquement le port de l'OpenFox dans lequel il tourne. Redémarrez le plugin pour appliquer un changement.",
        },
      },
      {
        key: 'followSession',
        type: 'boolean',
        label: { en: 'Follow sessions started from OpenFox', fr: 'Suivre les sessions lancées depuis OpenFox' },
        description: {
          en: "When the agent works on the active session after a message sent from OpenFox (web UI), its answer, permission requests, questions and changed files reach Telegram too.",
          fr: "Quand l'agent travaille sur la session active après un message envoyé depuis OpenFox (interface web), sa réponse, ses demandes d'autorisation, ses questions et les fichiers modifiés arrivent aussi sur Telegram.",
        },
        default: false,
      },
      {
        key: 'historyCount',
        type: 'text',
        label: { en: 'History message count', fr: 'Nombre de messages d\'historique' },
        description: {
          en: 'Number of recent messages to show when opening a session (default 6).',
          fr: "Nombre de messages récents à afficher à l'ouverture d'une session (défaut 6).",
        },
        default: '6',
      },
      {
        key: 'historyChars',
        type: 'text',
        label: { en: 'Characters per history message', fr: "Caractères par message d'historique" },
        description: {
          en: 'A longer message in the history keeps its last characters, after "…" (default 500).',
          fr: "Un message plus long de l'historique garde ses derniers caractères, après « … » (défaut 500).",
        },
        default: '500',
      },
    ],
  })

  const settings = context.settings()
  const botToken = settings.botToken
  const baseUrl = resolveBaseUrl({
    argv: process.argv,
    env: process.env,
    configPort: configFilePort(),
    override: settings.openfoxUrl,
  })
  const authorizedUserId = normalizeUserId(settings.authorizedUserId)
  const rest = new OpenFoxRestClient({ baseUrl })

  // The plugin's row in the plugins menu opens a status panel. Registered
  // before the token check: without a token, the panel says what is missing.
  const statusContent = async () => {
    const live = context.settings()
    const status = runtime?.status() ?? { connection: 'off', chats: [] }
    let projects = []
    if (status.chats.some((c) => c.sessionId || c.projectId)) {
      try {
        projects = await rest.listProjects()
      } catch {}
    }
    const chats = await Promise.all(
      status.chats.map(async (chat) => {
        let detail = null
        if (chat.sessionId) {
          try {
            detail = await rest.getSessionDetail(chat.sessionId)
          } catch {}
        }
        const projectId = detail?.session?.projectId ?? chat.projectId
        return {
          chatId: chat.chatId,
          project: projects.find((p) => p.id === projectId)?.name ?? projectId ?? null,
          session: chat.sessionId ? (detail?.session?.metadata?.title ?? detail?.session?.title ?? chat.sessionId) : null,
          mode: detail?.session?.mode ?? null,
          running: chat.running || Boolean(detail?.session?.isRunning),
        }
      }),
    )
    return statusPanelContent({
      tokenSet: Boolean(live.botToken),
      authorizedUserId: normalizeUserId(live.authorizedUserId),
      bot: status.bot ?? null,
      connection: status.connection,
      lastError: status.lastError ?? null,
      chats,
    })
  }
  registry.registerUiPanel?.({
    id: 'status',
    title: L('Telegram Bridge', 'Telegram Bridge'),
    size: 'md',
    kind: 'declarative',
    content: [],
    footer: STATUS_FOOTER,
  })
  registry.registerUiAction?.({
    id: 'telegram-status',
    slot: 'plugin.menu',
    label: L('Telegram', 'Telegram'),
    onActivate: { kind: 'rpc', method: 'openStatus' },
  })
  registry.registerRpc?.('openStatus', async () => ({ openPanel: 'status', content: await statusContent() }))
  registry.registerRpc?.('refreshStatus', async () => ({ content: await statusContent() }))
  registry.registerRpc?.('initPanel', async () => ({ content: await statusContent() }))

  if (!botToken) {
    context.logger.warn('openfox-telegram: botToken is not set. Set it in plugin settings to activate.')
    return
  }

  const logger = context.logger
  const telegram = new TelegramClient({ token: botToken })
  const subscribe = createWsSubscribe(baseUrl, logger)
  // Read on each use, so a change in the Plugins tab applies without a restart
  // (only the bot token needs one).
  const historyCount = () => parseInt(context.settings().historyCount, 10) || 6
  const historyChars = () => parseInt(context.settings().historyChars, 10) || HISTORY_MESSAGE_CHARS
  runtime = createRuntime({
    telegram,
    rest,
    subscribe,
    logger,
    auth: {
      get userId() {
        return normalizeUserId(context.settings().authorizedUserId)
      },
    },
    historyCount,
    historyChars,
    follow: () => context.settings().followSession,
    storage: context.storage,
  })
  globalThis[RUNTIME_KEY] = runtime
  runtime.start()
  context.logger.info('openfox-telegram started', { baseUrl })
  if (!authorizedUserId) {
    context.logger.warn('openfox-telegram: authorizedUserId is not set, the bot answers nobody. Set it in plugin settings.')
  }
}

export function deactivate() {
  // Stop via globalThis too, so a deactivate from a fresh module instance
  // (cache-bust re-import) still reaches the live runtime.
  const oldRuntime = globalThis[RUNTIME_KEY]
  oldRuntime?.stop()
  globalThis[RUNTIME_KEY] = null
  runtime = null
}
