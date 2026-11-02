import { useEffect, useState } from 'react';
import { Check, ChevronRight, CircleAlert, FileCode2, Loader2, Play, ShieldCheck, Terminal, Wrench } from 'lucide-react';
import { api } from './api';
import type { ToolCallRecord } from '../src/toolkit/contracts';
import './tools.css';

type CatalogueEntry = { name: string; title: string; description: string; category: string; access: string; parameters: { properties?: Record<string, { type?: string; anyOf?: { type?: string }[] }>; required?: string[] } };
const groups: Record<string, string> = { files: '读取与定位', edits: '文件修改', checks: '执行检查', evidence: '结果与证据' };
const accessNames: Record<string, string> = { read: '只读工具', write: '修改任务副本', execute: '执行预配置检查' };
const dataTypes: Record<string, string> = { string: '文本', integer: '整数', number: '数字', array: '数组', object: '对象', null: '空值' };

export function ToolsPage({ hasActiveTask, onTask }: { hasActiveTask: boolean; onTask: (id: string) => void }) {
  const [tools, setTools] = useState<CatalogueEntry[]>([]);
  const [selected, setSelected] = useState('list_files');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ tools: CatalogueEntry[] }>('/api/tools').then(data => setTools(data.tools)).catch(error => setError(error.message)); }, []);
  async function demo() {
    setBusy(true); setError('');
    try { const response = await api<{ task: { id: string } }>('/api/tasks', { mode: 'tools_demo' }); onTask(response.task.id); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  const current = tools.find(tool => tool.name === selected);
  return <div className="tools-page"><header className="tools-heading"><div><span className="eyebrow">从模型请求，到真实执行</span><h1><Wrench size={24} />工具层</h1><p>查看 Agent 可用的能力、输入要求和执行边界。</p></div><button className="button primary" disabled={busy || hasActiveTask || !tools.length} onClick={() => void demo()}>{busy ? <Loader2 size={15} className="spin" /> : <Play size={14} />}运行工具演示</button></header>
    <div className="tools-demo-note"><ShieldCheck size={16} /><span>演示使用独立购物车项目，实际调用全部工具；无需密钥，不使用真实 LLM。</span></div>
    {error && <div className="analysis-error" role="alert"><CircleAlert size={16} />{error}</div>}
    <div className="tool-catalogue"><nav aria-label="工具目录">{Object.entries(groups).map(([group, title]) => <section key={group}><h2>{title}</h2>{tools.filter(tool => tool.category === group).map(tool => <button key={tool.name} className={selected === tool.name ? 'selected' : ''} onClick={() => setSelected(tool.name)}><span>{tool.title}<small>{tool.name}</small></span><ChevronRight size={14} /></button>)}</section>)}</nav><article className="tool-description">{current ? <><div className="tool-description-title"><span className="tool-glyph"><Terminal size={22} /></span><div><h2>{current.title}</h2><code>{current.name}</code></div></div><span className={`tool-access ${current.access}`}>{accessNames[current.access]}</span><p className="tool-purpose">{current.description}</p><h3>输入字段</h3>{Object.keys(current.parameters.properties || {}).length ? <div className="tool-fields">{Object.entries(current.parameters.properties || {}).map(([key, field]) => <div key={key}><code>{key}</code><span>{field.type ? dataTypes[field.type] || field.type : field.anyOf?.map(part => dataTypes[part.type || ''] || part.type).join(' / ') || '结构化数据'}</span><small>{current.parameters.required?.includes(key) ? '必填' : '可选'}</small></div>)}</div> : <p className="small muted">这个工具不需要输入参数。</p>}<details className="schema-disclosure"><summary>查看完整参数格式</summary><pre>{JSON.stringify(current.parameters, null, 2)}</pre></details><div className="tool-boundaries"><ShieldCheck size={18} /><div><strong>执行范围由程序控制</strong><p>工具只操作任务副本。只读任务不会获得修改或执行工具；检查只能使用项目预配置的名称。接受修改仍由你单独决定。</p></div></div></> : <div className="loading"><Loader2 size={18} className="spin" />正在加载工具目录</div>}</article></div><div className="tools-footnote"><Check size={14} />工具目录和模型声明来自同一注册表；调用结果会保留在具体任务的“工具记录”中。</div></div>;
}

export function ToolTrace({ taskId, calls }: { taskId: string; calls: ToolCallRecord[] }) {
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<{ record: ToolCallRecord; output: string; next_offset: number | null } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const current = calls.find(call => call.id === selected);
  useEffect(() => { setSelected(''); setDetail(null); }, [taskId]);
  useEffect(() => { if (!selected && calls.length) setSelected(calls[0]!.id); }, [calls, selected]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController(); setBusy(true); setError('');
    api<NonNullable<typeof detail>>(`/api/tasks/${taskId}/tool-calls/${selected}`, undefined, controller.signal).then(setDetail).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [taskId, selected, current?.status]);
  async function more() {
    if (!detail || detail.next_offset === null) return;
    setBusy(true);
    try { const next = await api<NonNullable<typeof detail>>(`/api/tasks/${taskId}/tool-calls/${selected}?offset=${detail.next_offset}`); setDetail(previous => previous?.record.id === next.record.id ? { ...next, output: previous.output + next.output } : previous); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  if (!calls.length) return <div className="panel-empty"><Wrench size={30} /><h3>尚无工具记录</h3><p>运行任务后，可查看每次调用的输入、输出和执行状态。</p></div>;
  const shown = detail?.record.id === selected ? detail : null;
  return <div className="tool-trace"><p className="trace-hint">“调用完成”表示工具正常返回；检查是否通过，以具体输出为准。</p><div className="trace-list">{calls.map((call, index) => <button key={call.id} className={selected === call.id ? 'selected' : ''} onClick={() => setSelected(call.id)}><span className={`trace-state ${call.status}`}>{call.status === 'running' ? <Loader2 size={13} className="spin" /> : call.status === 'failed' ? <CircleAlert size={13} /> : <Check size={13} />}</span><span>{index + 1}. {call.title || call.name}<small>{call.status === 'running' ? '执行中' : call.status === 'failed' ? call.result?.error?.code || '调用失败' : '调用完成'}</small></span><time>{call.duration_ms ?? '…'} ms</time></button>)}</div>
    {error && <div className="inline-error" role="alert">{error}</div>}{shown && <section className="trace-detail"><h3><FileCode2 size={14} />{shown.record.name}</h3><div className="trace-meta"><span>{shown.record.source === 'model' ? '模型调用' : shown.record.source === 'runtime' ? '运行程序调用' : '直接调用'}</span><span title={selected}>{selected.slice(0, 8)}</span></div><h4>输入（已脱敏）</h4><pre>{JSON.stringify(shown.record.arguments, null, 2)}</pre><h4>输出（已脱敏）</h4><pre>{shown.output}</pre>{shown.next_offset !== null && <button className="button secondary trace-more" disabled={busy} onClick={() => void more()}>{busy ? <Loader2 size={12} className="spin" /> : null}继续读取结果</button>}</section>}{busy && !shown && <div className="loading"><Loader2 size={17} className="spin" />读取调用记录</div>}</div>;
}
