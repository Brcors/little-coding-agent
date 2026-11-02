import { StrictMode, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Bug, Check, CheckCheck, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Code2, FileCode2, FileDiff, Folder, FolderOpen, GitBranch, ListChecks, Loader2, PanelLeft, Play, Plus, ScanText, Search, Settings2, ShieldCheck, Square, Terminal, Trash2, Wrench, X } from 'lucide-react';
import type { Task } from '../src/types';
import './styles.css';
import { api, setCsrf } from './api';
import { RequirementAgent, type AnalysisSeed } from './analysis-panel';
import { ToolsPage, ToolTrace } from './tool-panels';
import { SemanticCard } from './semantic-card';
import type { ToolCallRecord } from '../src/toolkit/contracts';

type TaskView = Pick<Task, 'id' | 'source' | 'goal' | 'semantic' | 'tool_policy' | 'original_goal' | 'analysis_id' | 'provider' | 'model' | 'execution' | 'status' | 'created_at' | 'turns' | 'usage' | 'verification' | 'summary' | 'error' | 'checks'> & { active: boolean };
type AgentEvent = { time: string; type: string; data: { name?: string; path?: string; turn?: number; ok?: boolean; status?: string; code?: string; log_file?: string; names?: string[]; text?: string; policy?: string } };
type Change = { path: string; kind: string; diff: string; additions: number; deletions: number };
type Detail = { task: TaskView; events: AgentEvent[]; changes: Change[]; tool_calls?: ToolCallRecord[] };
type ReviewTab = 'diff' | 'checks' | 'tools';
type Session = { csrf: string; configured: boolean; keyConfigured: boolean; model: string; cwd: string };
const labels: Record<string, string> = { running: '执行中', review_ready: '待审阅', accepted: '已接受', discarded: '已丢弃', failed: '未通过', cancelled: '已停止', budget_exhausted: '达到限制', passed: '已通过', unverified: '未验证', unavailable: '不可用', timeout: '超时' };
const toolNames: Record<string, string> = { list_files: '浏览项目文件', read_file: '读取代码', search_text: '搜索相关代码', replace_text: '修改代码', create_file: '创建文件', run_check: '运行检查', inspect_diff: '审阅代码差异', apply_patch: '应用多文件补丁', restore_files: '恢复副本文件', read_tool_output: '分段读取工具结果' };
const basename = (value: string) => value.replaceAll('\\', '/').split('/').at(-1) || value;
const date = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const DEMO_GOAL = '修复空购物车总价计算错误，保留现有测试。';
function Status({ value, active = false }: { value: string; active?: boolean }) {
  return <span className={`status status-${value}`}>{active ? <Loader2 size={12} className="spin" /> : value === 'passed' || value === 'accepted' ? <CheckCircle2 size={12} /> : <span className="status-dot" />}{labels[value] || value}</span>;
}
function Modal({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={`modal ${className}`} aria-label={title} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>{children}
  </dialog>;
}
function FolderPicker({ initial, onSelect, onClose }: { initial: string; onSelect: (value: string) => void; onClose: () => void }) {
  const [folder, setFolder] = useState<{ path: string; parent: string; folders: { name: string; path: string }[]; truncated: boolean } | null>(null);
  const [input, setInput] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function visit(value: string) {
    setBusy(true); setError('');
    try { const next = await api<NonNullable<typeof folder>>(`/api/folders?path=${encodeURIComponent(value)}`); setFolder(next); setInput(next.path); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { void visit(initial); }, []);
  return <Modal title="选择项目文件夹" onClose={onClose}>
    <form className="folder-location" onSubmit={event => { event.preventDefault(); void visit(input); }}><button type="button" className="icon-button" disabled={busy || !folder || folder.path === folder.parent} onClick={() => folder && void visit(folder.parent)} aria-label="上一级"><ArrowLeft size={17} /></button><input aria-label="文件夹路径" value={input} onChange={event => setInput(event.target.value)} /><button className="button secondary" disabled={busy}>前往</button></form>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="folder-list" aria-busy={busy}>{busy ? <div className="loading"><Loader2 className="spin" size={20} />读取文件夹</div> : folder?.folders.length ? folder.folders.map(item => <button key={item.path} className="folder-row" onClick={() => void visit(item.path)}><Folder size={18} /><span>{item.name}</span><ChevronRight size={16} /></button>) : <p className="muted folder-empty">此文件夹没有可浏览的子文件夹，可以直接选择。</p>}</div>
    {folder?.truncated && <p className="small muted">仅显示前 200 个子文件夹，也可直接输入路径。</p>}
    <div className="modal-footer"><span className="small muted">选择项目根目录，原文件会保留到你接受修改时。</span><button className="button primary" disabled={!folder || busy} onClick={() => folder && onSelect(folder.path)}><Check size={15} />选择此文件夹</button></div>
  </Modal>;
}
function Diff({ change }: { change: Change }) {
  let oldLine = 0, newLine = 0;
  const rows: { text: string; old?: number; next?: number; kind: string }[] = [];
  for (const line of change.diff.split('\n')) {
    if (line.startsWith('@@')) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldLine = Number(match?.[1] || 0); newLine = Number(match?.[2] || 0);
      rows.push({ text: line, kind: 'hunk' });
    } else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('===') || !line) continue;
    else if (line.startsWith('+')) rows.push({ text: line, next: newLine++, kind: 'added' });
    else if (line.startsWith('-')) rows.push({ text: line, old: oldLine++, kind: 'deleted' });
    else if (line.startsWith(' ')) rows.push({ text: line, old: oldLine++, next: newLine++, kind: 'context' });
    else rows.push({ text: line, kind: 'context' });
  }
  return <details className="diff-file" open><summary><FileCode2 size={15} /><span title={change.path}>{change.path}</span><span className="diff-count"><b>+{change.additions}</b><i>−{change.deletions}</i></span><ChevronDown size={14} /></summary><div className="diff-scroll" tabIndex={0} aria-label={`${change.path} 代码差异`}><div className="diff-content">{rows.map((row, index) => <div className={`diff-line ${row.kind}`} key={index}><span className="line-number">{row.old ?? ''}</span><span className="line-number">{row.next ?? ''}</span><code>{row.text}</code></div>)}</div></div></details>;
}
function Review({ detail, tab, setTab, onAction, busy, onError }: { detail: Detail | null; tab: ReviewTab; setTab: (tab: ReviewTab) => void; onAction: (action: string) => void; busy: string; onError: (error: string) => void }) {
  const [logFile, setLogFile] = useState('');
  const [logText, setLogText] = useState('');
  const task = detail?.task;
  const checks = useMemo(() => detail?.events.filter(event => event.type === 'check.completed') || [], [detail?.events]);
  useEffect(() => { setLogFile(''); setLogText(''); }, [task?.id]);
  useEffect(() => { if (tab === 'checks' && !logFile && checks.length) setLogFile(checks.at(-1)!.data.log_file || ''); }, [tab, checks, logFile]);
  useEffect(() => {
    if (!task || !logFile) return;
    const controller = new AbortController(); setLogText('');
    api<{ text: string }>(`/api/tasks/${task.id}/logs/${logFile}`, undefined, controller.signal).then(result => setLogText(result.text)).catch(error => { if (!controller.signal.aborted) onError(error.message); });
    return () => controller.abort();
  }, [task?.id, logFile]);
  if (!detail) return <aside className="review-panel welcome-review"><div className="panel-title"><GitBranch size={16} /><span>从需求到可审阅的代码</span></div><div className="workflow-intro"><div className="workflow-logo"><Terminal size={27} /></div><h3>每一步，都看得见。</h3><p>Agent 在独立副本中完成任务，<br />最终改动由你来决定。</p></div><ol className="workflow"><li><span>1</span><div><strong>描述你的目标</strong><p>选择项目，告诉 Agent 要做什么</p></div></li><li><span>2</span><div><strong>跟随执行过程</strong><p>查看代码读取、修改与检查记录</p></div></li><li><span>3</span><div><strong>审阅并接受修改</strong><p>确认差异，再写回原项目</p></div></li></ol><div className="review-note"><ShieldCheck size={17} /><p>所有改动先保存在任务副本中。</p></div></aside>;
  const additions = detail.changes.reduce((sum, change) => sum + change.additions, 0);
  const deletions = detail.changes.reduce((sum, change) => sum + change.deletions, 0);
  const reviewable = !task!.active && ['review_ready', 'failed', 'cancelled', 'budget_exhausted'].includes(task!.status);
  return <aside className="review-panel"><div className="review-tabs" role="tablist" aria-label="任务结果"><button role="tab" aria-selected={tab === 'diff'} className={tab === 'diff' ? 'active' : ''} onClick={() => setTab('diff')}><FileDiff size={15} />代码变更<span>{detail.changes.length}</span></button><button role="tab" aria-selected={tab === 'checks'} className={tab === 'checks' ? 'active' : ''} onClick={() => setTab('checks')}><ListChecks size={15} />检查记录<span>{checks.length}</span></button><button role="tab" aria-selected={tab === 'tools'} className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')}><Wrench size={14} />工具记录<span>{detail.tool_calls?.length || 0}</span></button></div>
    <div className="review-body">{tab === 'diff' ? <>{detail.changes.length ? <><div className="change-overview"><span>{detail.changes.length} 个文件有修改</span><span className="diff-count"><b>+{additions}</b><i>−{deletions}</i></span></div>{detail.changes.map(change => <Diff key={change.path} change={change} />)}</> : <div className="panel-empty"><FileDiff size={30} /><h3>{task!.active ? '等待代码修改' : '没有代码变更'}</h3><p>{task!.active ? 'Agent 生成的修改会显示在这里。' : '本次任务没有产生文件差异。'}</p></div>}</> : tab === 'tools' ? <ToolTrace taskId={task!.id} calls={detail.tool_calls || []} /> : <>{checks.length ? <><div className="check-history">{checks.map((event, index) => <button key={index} className={`check-row ${logFile === event.data.log_file ? 'selected' : ''}`} onClick={() => setLogFile(event.data.log_file || '')}>{event.data.status === 'passed' ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}<span>{event.data.name}<small>第 {index + 1} 次检查</small></span><Status value={event.data.status || 'unverified'} /></button>)}</div><div className="log-heading"><Terminal size={14} /><span>实际执行输出</span></div><pre className="log-output">{logText || '正在读取日志…'}</pre></> : <div className="panel-empty"><ListChecks size={30} /><h3>尚无检查记录</h3><p>检查执行后，会在这里保留每次结果和日志。</p></div>}</>}</div>
    <div className="review-footer"><div className="verification-line"><span>当前代码验证</span><Status value={task!.verification} /></div>{task!.status === 'accepted' ? <div className="accepted-note"><CheckCheck size={17} />修改已写回原项目</div> : task!.status === 'discarded' ? <div className="discarded-note"><Trash2 size={16} />本次修改已丢弃，原项目未改动</div> : <><div className="review-actions"><button className="button secondary" disabled={!reviewable || !!busy} onClick={() => onAction('discard')}><Trash2 size={14} />丢弃</button><button className="button primary" disabled={!reviewable || !detail.changes.length || !!busy} onClick={() => onAction('accept')}>{busy === 'accept' ? <Loader2 size={15} className="spin" /> : <Check size={15} />}接受修改</button></div><p className="small muted">{task!.active ? '任务结束后，即可审阅并接受修改。' : task!.verification !== 'passed' ? '检查尚未通过，请结合差异与日志判断。' : '确认后，将这些改动写回原项目。'}</p></>}</div></aside>;
}

function App() {
  const initialId = /^#task\/([a-f0-9-]{36})$/.exec(location.hash)?.[1] || '';
  const [session, setSession] = useState<Session | null>(null);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [selected, setSelected] = useState(initialId);
  const [analysisView, setAnalysisView] = useState(location.hash.startsWith('#analysis'));
  const [toolsView, setToolsView] = useState(location.hash.startsWith('#tools'));
  const [analysisId, setAnalysisId] = useState(/^#analysis\/([a-f0-9-]{36})$/.exec(location.hash)?.[1] || '');
  const [analysisSeed, setAnalysisSeed] = useState<AnalysisSeed | null>(null);
  const analysisFolderPicker = useRef<((path: string) => void) | null>(null);
  const [folderInitial, setFolderInitial] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'demo' | 'openai'>('demo');
  const [project, setProject] = useState('');
  const [goal, setGoal] = useState('');
  const [execution, setExecution] = useState('docker');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [tab, setTab] = useState<ReviewTab>('diff');
  const [connected, setConnected] = useState(true);
  const current = detail?.task.id === selected ? detail : null;
  const task = current?.task;
  const anyActive = tasks.some(task => task.active);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !settings && !folderOpen && !['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) && !element.isContentEditable) { event.preventDefault(); selectTask(''); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [settings, folderOpen]);
  async function refreshTasks() { const result = await api<{ tasks: TaskView[] }>('/api/tasks'); setTasks(result.tasks); setConnected(true); }
  function selectTask(id: string) { setToolsView(false); setAnalysisView(false); setAnalysisId(''); setSelected(id); setError(''); setTab('diff'); setSidebar(false); history.replaceState(null, '', id ? `#task/${id}` : location.pathname); }
  function openAnalysis(seed: AnalysisSeed | null = null) { setToolsView(false); setAnalysisSeed(seed || { key: crypto.randomUUID(), request: '', project: '', mode: session?.configured ? 'openai' : 'rules', execution: 'docker', model, auto: false }); setSelected(''); setAnalysisId(''); setAnalysisView(true); setSidebar(false); setError(''); history.replaceState(null, '', '#analysis'); }
  useEffect(() => {
    let stopped = false;
    api<Session>('/api/session').then(async result => { setCsrf(result.csrf); if (stopped) return; setSession(result); setMode(result.configured ? 'openai' : 'demo'); await refreshTasks(); }).catch(error => { if (!stopped) { setError(error.message); setConnected(false); } });
    return () => { stopped = true; };
  }, []);
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => void refreshTasks().catch(() => setConnected(false)), 3000);
    return () => clearInterval(timer);
  }, [session]);
  useEffect(() => {
    if (!selected || !session) { setDetail(null); return; }
    const controller = new AbortController();
    api<Detail>(`/api/tasks/${selected}`, undefined, controller.signal).then(setDetail).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [selected, session]);
  useEffect(() => {
    if (!selected || !task?.active) return;
    const stream = new EventSource(`/api/tasks/${selected}/stream`);
    stream.addEventListener('snapshot', event => { const next: Detail = JSON.parse(event.data); setDetail(next); setConnected(true); if (!next.task.active) { stream.close(); void refreshTasks().catch(() => {}); } });
    stream.onerror = () => setConnected(false);
    return () => stream.close();
  }, [selected, task?.active]);
  async function start(override?: 'demo') {
    const selectedMode = override || mode;
    openAnalysis({ key: crypto.randomUUID(), request: selectedMode === 'demo' ? DEMO_GOAL : goal, project: selectedMode === 'demo' ? '' : project, mode: selectedMode === 'demo' ? 'demo' : session?.configured ? 'openai' : 'rules', model, execution: execution as 'docker' | 'disabled', auto: true });
  }
  async function action(action: string) {
    if (!task) return;
    setBusy(action); setError('');
    try {
      const result = await api<Detail>(`/api/tasks/${task.id}/${action}`, {});
      if (action !== 'cancel') setDetail(result);
      await refreshTasks();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(''); }
  }
  const visibleTasks = tasks.filter(task => `${task.goal} ${task.source}`.toLowerCase().includes(query.toLowerCase()));
  const events = current?.events.filter(event => ['task.started', 'semantic.received', 'model.tool_selection', 'assistant.message', 'tool.started', 'check.completed', 'task.finished', 'task.accepted', 'task.discarded'].includes(event.type) || event.type === 'tool.finished' && !event.data.ok) || [];
  const canStart = session && !busy && (mode === 'demo' || project.trim() && goal.trim());
  return <div className="app-shell">
    <aside className={`sidebar ${sidebar ? 'sidebar-open' : ''}`}><a href="#" className="brand" onClick={event => { event.preventDefault(); selectTask(''); }}><span className="brand-icon"><Terminal size={20} /></span><span>Little Agent<small>你的本地编程伙伴</small></span></a><button className="button new-task" onClick={() => selectTask('')}><Plus size={17} />新建任务<span className="shortcut">N</span></button><button className={`analysis-nav ${analysisView ? 'selected' : ''}`} onClick={() => openAnalysis()}><ScanText size={16} />问题解析<span>先理解需求</span></button><button className={`analysis-nav tools-nav ${toolsView ? 'selected' : ''}`} onClick={() => { setToolsView(true); setAnalysisView(false); setSelected(''); setSidebar(false); history.replaceState(null, '', '#tools'); }}><Wrench size={16} />工具层<span>查看能力与记录</span></button><div className="sidebar-section-heading"><span>最近任务</span><span>{tasks.length}</span></div><div className="task-search"><Search size={14} /><input aria-label="搜索任务" placeholder="搜索任务…" value={query} onChange={event => setQuery(event.target.value)} /></div><nav className="task-list" aria-label="最近任务">{visibleTasks.length ? visibleTasks.map(item => <button key={item.id} className={`task-item ${selected === item.id ? 'selected' : ''}`} onClick={() => selectTask(item.id)}><div className="task-item-title">{item.active ? <Loader2 size={14} className="spin" /> : <span className={`task-dot task-dot-${item.status}`} />}<span>{item.original_goal || item.goal}</span></div><div className="task-item-meta"><span>{item.provider === 'demo' ? '演示' : basename(item.source)}</span><span>{labels[item.status]}</span></div></button>) : <div className="task-list-empty">{query ? '没有匹配的任务' : '开始一个任务，记录会保存在这里。'}</div>}</nav><div className="sidebar-bottom"><button className="sidebar-settings" onClick={() => setSettings(true)}><Settings2 size={16} />连接与设置<ChevronRight size={14} /></button><div className="local-status"><span className={connected ? 'online-dot' : 'offline-dot'} />{connected ? '本地服务已连接' : '服务连接已断开'}<span>v0.5</span></div></div></aside>
    {sidebar && <button className="sidebar-shade" aria-label="关闭任务列表" onClick={() => setSidebar(false)} />}
    <div className="workspace"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="打开任务列表" onClick={() => setSidebar(true)}><PanelLeft size={18} /></button><span>工作空间</span><ChevronRight size={13} /><strong>{task ? task.provider === 'demo' ? '购物车演示项目' : basename(task.source) : toolsView ? '工具层' : analysisView ? '问题解析' : '新建任务'}</strong>{task?.provider === 'demo' && <span className="quiet-badge">演示</span>}</div><button className="connection-button" onClick={() => setSettings(true)}><span className={session?.configured ? 'online-dot' : 'neutral-dot'} />{session?.configured ? session.model : '模型未连接'}<Settings2 size={13} /></button></header>
      {error && <div className="error-banner" role="alert"><CircleAlert size={17} /><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></button></div>}
      {!connected && <div className="disconnect-banner" role="status">本地服务连接已断开。请确认服务仍在运行，然后刷新页面重连。</div>}
      <div className={`workbench-columns ${analysisView || toolsView ? 'analysis-columns' : ''}`}><main className={`main-panel ${analysisView || toolsView ? 'analysis-main' : selected ? 'task-main' : 'new-main'}`}>
        {toolsView ? session ? <ToolsPage hasActiveTask={anyActive} onTask={id => { selectTask(id); setTab('tools'); void refreshTasks(); }} /> : <div className="loading">正在连接工作台…</div> : analysisView ? session ? <RequirementAgent key={analysisSeed?.key || 'restored'} id={analysisId} seed={analysisSeed} configured={session.keyConfigured && !!(model || session.model)} defaultModel={model || session.model} hasActiveTask={anyActive} onSaved={id => { setAnalysisId(id); history.replaceState(null, '', `#analysis/${id}`); }} onTask={id => { void refreshTasks(); selectTask(id); }} onSettings={() => setSettings(true)} onBrowse={(initial, select) => { analysisFolderPicker.current = select; setFolderInitial(initial); setFolderOpen(true); }} /> : <div className="loading">正在连接工作台…</div> : selected ? current ? <><div className="task-heading"><div className="eyebrow">{task!.provider === 'demo' ? '演示任务 · 不使用真实模型' : '项目任务'}<span>{date(task!.created_at)}</span></div><h1>{task!.original_goal || task!.goal}</h1><div className="task-heading-bottom"><Status value={task!.status} active={task!.active} />{task!.tool_policy === 'read_only' && <span className="quiet-badge">只读任务</span>}<span className="task-project" title={task!.source}><Folder size={13} />{task!.provider === 'demo' ? '独立购物车练习项目' : task!.source}</span>{task!.active && <button className="button stop-button" disabled={!!busy} onClick={() => void action('cancel')}><Square size={12} />{busy === 'cancel' ? '正在停止' : '停止任务'}</button>}</div></div><div className="activity-area">{task!.semantic && <SemanticCard context={task!.semantic} model={task!.model} demo={task!.provider === 'demo'} active={task!.active} finished={!task!.active && task!.status !== 'running'} />}<div className="agent-identity"><span className="agent-avatar"><Terminal size={17} /></span><div><strong>Little Agent</strong><span>{task!.provider === 'demo' ? '固定演示驱动 · 实际执行文件修改与测试' : task!.model}</span></div></div><div className="activity-feed">{events.map((event, index) => {
          const failed = event.type === 'check.completed' && event.data.status !== 'passed' || event.type === 'tool.finished';
          const complete = event.type === 'task.finished';
          let text = event.type === 'semantic.received' ? '需求理解已交接，按语义和权限选择工具' : event.type === 'model.tool_selection' ? (task!.provider === 'demo' ? '演示请求工具：' : '模型选择工具：') + (event.data.names || []).map(name => toolNames[name] || name).join('、') : event.type === 'assistant.message' ? event.data.text : event.type === 'task.started' ? '准备项目副本，开始处理任务' : event.type === 'tool.started' ? toolNames[event.data.name || ''] || event.data.name : event.type === 'check.completed' ? `检查 ${event.data.name}：${labels[event.data.status || ''] || event.data.status}` : event.type === 'tool.finished' ? `工具未完成：${event.data.code}` : event.type === 'task.accepted' ? '修改已接受，写回原项目' : event.type === 'task.discarded' ? '本次修改已丢弃' : '任务执行结束，结果已保存';
          return <div className={`activity-row ${failed ? 'activity-failed' : event.type === 'model.tool_selection' ? 'model-choice' : ''}`} key={`${event.time}-${index}`}><span className="activity-icon">{failed ? <CircleAlert size={14} /> : event.type === 'model.tool_selection' ? <Wrench size={13} /> : complete || event.type === 'check.completed' ? <CheckCircle2 size={14} /> : <Check size={14} />}</span><div><span>{text}</span>{event.data.path && <code>{event.data.path}</code>}</div><time>{new Date(event.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time></div>;
        })}{task!.active && <div className="working-indicator" role="status"><span className="working-pulse" /><span>正在处理任务<span className="muted">，执行记录会实时更新</span></span></div>}</div>{task!.summary && <div className="agent-summary"><h3>任务结果</h3><p>{task!.summary}</p></div>}{task!.error && <div className="task-error"><CircleAlert size={16} /><span>{task!.error}</span></div>}{!task!.active && <div className="task-completion"><ShieldCheck size={16} /><span>{task!.status === 'accepted' ? '本次修改已写回项目。' : task!.status === 'discarded' ? '本次修改已丢弃，记录继续保留。' : '修改保存在任务副本中，请在结果区审阅。'}</span></div>}</div><div className="task-bottom"><span>{task!.turns} 轮处理<span className="dot-separator">·</span>{(task!.usage.input_tokens + task!.usage.output_tokens).toLocaleString()} tokens</span>{!task!.active && <a className="text-link" href={`/api/tasks/${task!.id}/report`} download><ArrowDownToLine size={14} />下载任务报告</a>}</div></> : <div className="loading"><Loader2 className="spin" size={20} />正在读取任务…</div> : <div className="new-task-content"><div className="welcome-copy"><div className="eyebrow"><span className="tiny-line" />LET’S BUILD SOMETHING</div><h1>把想法，变成代码。</h1><p>选择一个项目，描述你想完成的事。<br className="desktop-break" />Little Agent 会帮你查找、修改和验证。</p></div><div className="suggestions">{[{ icon: Bug, title: '修复一个问题', text: '定位问题，修复异常', goal: '查找并修复一个边界条件错误，保留现有功能和测试。' }, { icon: Code2, title: '实现一个功能', text: '从小功能开始迭代', goal: '为项目实现一个小功能，并补充必要的验证。' }, { icon: ListChecks, title: '完善代码测试', text: '覆盖容易遗漏的场景', goal: '阅读现有实现，为边界情况补充测试，保持现有功能。' }].map(item => <button className="suggestion" key={item.title} onClick={() => { setMode('openai'); setGoal(item.goal); }}><item.icon size={19} /><strong>{item.title}</strong><span>{item.text}</span><ArrowUpRight className="suggestion-arrow" size={14} /></button>)}</div>
        <form className="composer" onSubmit={event => { event.preventDefault(); if (canStart) void start(); }}><div className="composer-top"><div className="mode-switch" aria-label="任务模式"><button type="button" className={mode === 'demo' ? 'active' : ''} aria-pressed={mode === 'demo'} onClick={() => setMode('demo')}><Play size={13} />演示体验</button><button type="button" className={mode === 'openai' ? 'active' : ''} aria-pressed={mode === 'openai'} onClick={() => setMode('openai')}><FolderOpen size={14} />真实项目</button></div><span className="composer-hint">{mode === 'demo' ? '无需密钥' : '本地项目'}</span></div><div className="project-input"><Folder size={17} /><input aria-label="项目路径" placeholder="输入项目文件夹的完整路径" readOnly={mode === 'demo'} value={mode === 'demo' ? '内置购物车练习项目' : project} onChange={event => setProject(event.target.value)} /><button className="browse-button" type="button" disabled={mode === 'demo'} onClick={() => setFolderOpen(true)}>浏览</button></div><label className="sr-only" htmlFor="goal">任务描述</label><textarea id="goal" placeholder="你想完成什么？描述目标、需要保留的行为或验收标准…" readOnly={mode === 'demo'} value={mode === 'demo' ? DEMO_GOAL : goal} onChange={event => setGoal(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && canStart) { event.preventDefault(); void start(); } }} /><div className="composer-footer"><div className="execution-choice"><ShieldCheck size={14} />{mode === 'demo' ? <span>运行内置样例检查</span> : <select aria-label="检查方式" value={execution} onChange={event => setExecution(event.target.value)}><option value="docker">隔离检查 · Docker</option><option value="disabled">仅生成修改 · 不执行检查</option></select>}</div><button className="button primary start-button" disabled={!canStart} type="submit">{busy === 'create' ? <Loader2 size={15} className="spin" /> : <ArrowRight size={16} />}{busy === 'create' ? '正在创建' : mode === 'demo' ? '解析演示需求' : '先解析需求'}</button></div></form>
        <div className="composer-caption"><span>{mode === 'demo' ? '固定演示流程，体验测试失败到修复通过，不会调用真实模型。' : '只修改任务副本，接受后才会写回原项目。'}</span>{mode === 'openai' && <kbd>Ctrl ↵</kbd>}</div>{mode === 'openai' && !session?.configured && <div className="setup-notice"><CircleAlert size={16} /><span>连接模型后，即可处理真实项目。</span><button className="text-link" onClick={() => setSettings(true)}>查看配置方法<ArrowRight size={13} /></button></div>}{anyActive && <div className="setup-notice"><Loader2 size={16} className="spin" /><span>已有任务在执行，可从左侧查看或停止。</span></div>}<div className="welcome-footer"><GitBranch size={14} /><span>每个任务独立执行，每一次修改都可审阅。</span></div></div>}
      </main>{!analysisView && !toolsView && <Review detail={current} tab={tab} setTab={setTab} onAction={value => void action(value)} busy={busy} onError={setError} />}</div></div>
    {folderOpen && <FolderPicker initial={folderInitial || project || session?.cwd || ''} onSelect={value => { if (analysisFolderPicker.current) analysisFolderPicker.current(value); else setProject(value); analysisFolderPicker.current = null; setFolderInitial(''); setFolderOpen(false); }} onClose={() => { analysisFolderPicker.current = null; setFolderInitial(''); setFolderOpen(false); }} />}
    {settings && <Modal title="连接与设置" onClose={() => setSettings(false)} className="settings-modal"><div className="settings-state"><span className="settings-state-icon"><Terminal size={22} /></span><div><strong>模型连接</strong><p>{session?.configured ? '已找到本地配置，可创建真实项目任务。' : '演示可直接使用；真实任务需要配置 API。'}</p></div><Status value={session?.configured ? 'passed' : 'unverified'} /></div><p className="settings-copy">在本项目根目录创建 <code>.env</code>，填入你的 API 凭据和可用模型 ID，然后重新启动工作台。密钥由本地后端读取。</p><pre className="env-example">OPENAI_API_KEY=你的密钥{'\n'}OPENAI_MODEL=可用的模型ID</pre><label className="field-label">本次使用的模型（可选）<input placeholder={session?.model || '默认使用 .env 中的 OPENAI_MODEL'} value={model} onChange={event => setModel(event.target.value)} /></label><p className="small muted">这里仅覆盖新任务的模型名称，不会保存或修改密钥。真实任务的相关代码片段会发送给模型服务。</p><div className="settings-divider" /><div className="settings-copy"><ShieldCheck size={17} /><span>真实项目默认通过 Docker 运行检查，也可在任务中选择只生成修改。</span></div><div className="modal-footer"><span className="small muted">Little Agent · 本地工作台 v0.5</span><button className="button primary" onClick={() => setSettings(false)}>完成</button></div></Modal>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
