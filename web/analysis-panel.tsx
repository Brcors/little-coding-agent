import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, CheckCircle2, ChevronRight, CircleAlert, FolderOpen, History, Loader2, MessageCircleQuestion, ScanText, ShieldCheck, Square } from 'lucide-react';
import type { AnalysisRecord, RequirementIntent } from '../src/analysis-types';
import { api } from './api';
import './analysis.css';
import './semantic.css';

export interface AnalysisSeed {
  key: string;
  request: string;
  project: string;
  mode: AnalysisRecord['mode'];
  execution: 'docker' | 'disabled';
  model: string;
  auto: boolean;
}
interface Props {
  id: string;
  seed: AnalysisSeed | null;
  configured: boolean;
  defaultModel: string;
  hasActiveTask: boolean;
  onSaved: (id: string) => void;
  onTask: (id: string) => void;
  onSettings: () => void;
  onBrowse: (initial: string, select: (path: string) => void) => void;
}
const intentNames: Record<RequirementIntent, string> = { bug_fix: '修复问题', feature: '实现功能', tests: '补充测试', refactor: '重构代码', explain: '解释代码', review: '审查代码', other: '其他任务' };
const DEMO = '修复空购物车总价计算错误，保留现有测试。';
function SpecList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <section className="spec-section"><h3>{title}</h3><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></section>;
}
export function RequirementAgent(props: Props) {
  const [request, setRequest] = useState(props.seed?.request || '');
  const [project, setProject] = useState(props.seed?.project || '');
  const [mode, setMode] = useState<AnalysisRecord['mode']>(props.seed?.mode || (props.configured ? 'openai' : 'rules'));
  const [execution, setExecution] = useState<'docker' | 'disabled'>(props.seed?.execution || 'docker');
  const [record, setRecord] = useState<AnalysisRecord | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<{ id: string; original_request: string; status: string }[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const auto = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const model = props.seed?.model || props.defaultModel;
  const dirty = !!record && (request.trim() !== record.original_request || project.trim() !== record.project && project.trim().replaceAll('/', '\\') !== record.project || mode !== record.mode || execution !== record.execution);
  async function refreshHistory() { setHistory((await api<{ analyses: typeof history }>('/api/analyses')).analyses); }
  function adopt(next: AnalysisRecord) {
    setRecord(next); setRequest(next.original_request); setProject(next.project); setMode(next.mode); setExecution(next.execution); setAnswers({}); props.onSaved(next.id);
  }
  async function load(id: string) {
    setBusy('load'); setError('');
    try { adopt((await api<{ analysis: AnalysisRecord }>(`/api/analyses/${id}`)).analysis); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(''); }
  }
  async function analyse() {
    setBusy('parse'); setError('');
    const abort = new AbortController(); controller.current = abort;
    try {
      const result = await api<{ analysis: AnalysisRecord }>('/api/analyses', { request: mode === 'demo' ? DEMO : request, project, mode, execution, model }, abort.signal);
      adopt(result.analysis); await refreshHistory();
    } catch (error) { setError(abort.signal.aborted ? '解析已停止，原有结果保留。' : (error as Error).message); }
    finally { setBusy(''); controller.current = null; }
  }
  async function refine() {
    if (!record) return;
    setBusy('refine'); setError('');
    const abort = new AbortController(); controller.current = abort;
    try {
      const cleanAnswers = Object.fromEntries(Object.entries(answers).filter(([, answer]) => answer.trim()));
      const next = await api<{ analysis: AnalysisRecord }>(`/api/analyses/${record.id}/refine`, { revision: record.revision, answers: cleanAnswers }, abort.signal);
      adopt(next.analysis); await refreshHistory();
    } catch (error) { setError(abort.signal.aborted ? '补充解析已停止，之前的结果保留。' : (error as Error).message); }
    finally { setBusy(''); controller.current = null; }
  }
  async function execute() {
    if (!record) return;
    setBusy('execute'); setError('');
    try {
      const next = await api<{ task: { id: string } }>('/api/tasks', { mode: record.mode === 'demo' ? 'demo' : 'openai', analysis_id: record.id, analysis_revision: record.revision, model });
      props.onTask(next.task.id);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(''); }
  }
  useEffect(() => { void refreshHistory().catch(error => setError(error.message)); return () => controller.current?.abort(); }, []);
  useEffect(() => { if (props.id && props.id !== record?.id) void load(props.id); }, [props.id]);
  useEffect(() => { if (props.seed?.auto && !auto.current && !props.id) { auto.current = true; void analyse(); } }, []);
  const canAnalyse = !!request.trim() && !busy && (mode !== 'openai' || props.configured);
  const unanswered = record?.result.questions.some(question => question.required && !answers[question.id]?.trim());
  const hasDraftAnswers = Object.values(answers).some(answer => answer.trim());
  const canExecute = record?.status === 'ready' && !dirty && !hasDraftAnswers && !busy && !record.task_id && !props.hasActiveTask && (record.mode === 'demo' || !!record.project && props.configured);
  return <div className="analysis-layout"><div className="analysis-content">
    <div className="analysis-heading"><div className="eyebrow"><span>先理解，再动手</span><span className="analysis-step">01 需求解析<ChevronRight size={11} />02 代码执行</span></div><h1><ScanText size={24} />用户问题解析</h1><p>把一句话整理成明确目标。关键细节不清楚时，先补充回答。</p></div>
    <div className="analysis-toolbar"><label><History size={14} /><select aria-label="历史解析" value={record?.id || ''} onChange={event => { if (event.target.value) void load(event.target.value); }} disabled={!!busy}><option value="">查看历史解析</option>{history.map(item => <option value={item.id} key={item.id}>{item.original_request.slice(0, 38)}</option>)}</select></label><span>{record ? `第 ${record.revision} 版` : '独立解析，不修改代码'}</span></div>
    <form className="analysis-form" onSubmit={event => { event.preventDefault(); if (canAnalyse) void analyse(); }}>
      <div className="analysis-mode"><label>解析方式<select aria-label="解析方式" value={mode} onChange={event => { const mode = event.target.value as AnalysisRecord['mode']; setMode(mode); if (mode === 'demo') setRequest(DEMO); }} disabled={!!busy}><option value="rules">规则解析 · 无需密钥</option><option value="openai">LLM 解析 · 结构化输出</option><option value="demo">购物车演示</option></select></label><span>{mode === 'openai' ? '调用已配置的模型' : '本地规则，不调用 LLM'}</span></div>
      <label className="field-label analysis-request-label" htmlFor="analysis-request">你的原始问题</label><textarea id="analysis-request" aria-label="原始问题" maxLength={4000} placeholder="例如：帮我优化一下购物车；或者明确描述当前问题、预期结果和需要保留的行为。" value={request} readOnly={mode === 'demo'} disabled={!!busy} onChange={event => setRequest(event.target.value)} />
      <div className="analysis-context"><label>项目目录（可选）<div><input aria-label="解析项目目录" value={project} onChange={event => setProject(event.target.value)} placeholder="只解析需求时可以留空" disabled={!!busy || mode === 'demo'} /><button type="button" className="icon-button" aria-label="浏览解析项目" disabled={!!busy || mode === 'demo'} onClick={() => props.onBrowse(project, setProject)}><FolderOpen size={16} /></button></div></label><label>后续检查<select aria-label="解析后检查方式" value={execution} onChange={event => setExecution(event.target.value as typeof execution)} disabled={!!busy}><option value="docker">Docker 隔离检查</option><option value="disabled">仅生成修改</option></select></label></div>
      <div className="analysis-form-footer"><span><ShieldCheck size={13} />此阶段不读取、修改或执行项目代码</span><button type={busy ? 'button' : 'submit'} className={`button ${busy ? 'secondary' : 'primary'}`} disabled={busy === 'load' || busy === 'execute' || !busy && !canAnalyse} onClick={busy ? () => controller.current?.abort() : undefined}>{busy === 'parse' || busy === 'refine' ? <><Square size={12} />停止解析</> : <><ScanText size={15} />{record ? '重新解析' : '解析问题'}</>}</button></div>
    </form>
    {mode === 'openai' && !props.configured && <div className="setup-notice"><CircleAlert size={15} /><span>LLM 解析需要本地模型配置；也可选择规则解析。</span><button className="text-link" onClick={props.onSettings}>连接模型</button></div>}
    {error && <div className="analysis-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
    {busy === 'parse' && <div className="analysis-progress" role="status"><Loader2 size={17} className="spin" />正在提取目标、约束与验收标准…</div>}
    {record && <div className={`analysis-result ${dirty ? 'analysis-dirty' : ''}`}><div className="analysis-result-heading"><div><span className="eyebrow">解析结果</span><h2>{record.result.title}</h2></div><span className={`analysis-state ${record.status}`}>{record.status === 'ready' ? <CheckCircle2 size={14} /> : <MessageCircleQuestion size={14} />}{record.status === 'ready' ? '可交给执行 Agent' : '需要补充关键问题'}</span></div><div className="analysis-source"><span>{intentNames[record.result.intent]}</span><span>{record.source === 'llm' ? `LLM · ${record.model}` : '本地规则 · 未使用 LLM'}</span></div>
      {dirty && <div className="analysis-error"><CircleAlert size={15} />输入内容已修改，请重新解析后再确认执行。</div>}
      <section className="semantic-preview" aria-label="语义执行计划"><div className="semantic-preview-heading"><strong>理解后如何执行</strong><span>{record.execution_plan?.recommended_policy === 'read_only' ? '只读分析' : '修改任务副本'}</span></div><p>{record.mode === 'demo' ? '这是固定演示流程，不调用真实 LLM。' : '执行模型先获取项目内容，再根据目标和每次工具结果选择下一步，不按固定脚本调用工具。'}</p><details><summary>允许的工具范围 · {record.execution_plan?.available_tools.length || 0}</summary><div className="semantic-tools">{record.execution_plan?.available_tools.map(name => <code key={name}>{name}</code>)}</div><p>项目权限可进一步收紧；解释与审查任务不会获得写入或检查权限。</p></details></section><section className="spec-goal"><h3>理解后的目标</h3><p>{record.result.goal}</p></section><div className="spec-grid"><SpecList title="处理范围" items={record.result.scope} /><SpecList title="用户约束" items={record.result.constraints} /></div><SpecList title="验收标准" items={record.result.acceptance_criteria} /><SpecList title="范围之外" items={record.result.out_of_scope} /><SpecList title="假设与待核对事项" items={record.result.assumptions} />
      {!!record.answers.length && <details className="clarification-history"><summary>已收集的补充回答 · {record.answers.length}</summary>{record.answers.map((answer, index) => <div key={index}><strong>{answer.question}</strong><p>{answer.answer}</p></div>)}</details>}
      {!!record.result.questions.length && <form className="clarification-form" onSubmit={event => { event.preventDefault(); void refine(); }}><h3><MessageCircleQuestion size={17} />继续明确需求</h3>{record.result.questions.map(question => <div className="clarification-question" key={question.id}><label htmlFor={question.id}>{question.question}<span>{question.required ? '关键问题' : '可选补充'}</span></label><p>{question.reason}</p>{!!question.options.length && <div className="clarification-options">{question.options.map(option => <button key={option} type="button" onClick={() => setAnswers(previous => ({ ...previous, [question.id]: option }))} aria-pressed={answers[question.id] === option}>{option}</button>)}</div>}<textarea id={question.id} aria-label={question.question} maxLength={1000} placeholder="填写你的选择、具体对象或预期结果…" value={answers[question.id] || ''} onChange={event => setAnswers(previous => ({ ...previous, [question.id]: event.target.value }))} disabled={!!busy || !!record.task_id || dirty} /></div>)}<div className="clarification-submit"><span>已补充 {record.refinement_rounds}/3 轮</span><button className="button secondary" disabled={!!busy || unanswered || dirty || !!record.task_id || record.refinement_rounds >= 3 || !Object.values(answers).some(answer => answer.trim())}>{busy === 'refine' ? <Loader2 size={14} className="spin" /> : <Check size={14} />}补充并更新解析</button></div></form>}
      <div className="analysis-execute"><div><strong>{record.task_id ? '已创建执行任务' : '确认后，才会开始处理项目'}</strong><p>{record.task_id ? '这份解析已与任务关联，可继续查看执行结果。' : record.status !== 'ready' ? '请先回答上方关键问题。' : record.mode !== 'demo' && !record.project ? '如需执行，先填写项目目录并重新解析。' : record.mode !== 'demo' && !props.configured ? '规则解析可以单独使用；执行真实任务需要连接模型。' : '原始问题、补充回答与验收标准会一起传给 Coding Agent。'}</p></div>{record.task_id ? <button className="button secondary" onClick={() => props.onTask(record.task_id!)}>查看执行任务<ArrowRight size={14} /></button> : <button className="button primary" disabled={!canExecute} onClick={() => void execute()}>{busy === 'execute' ? <Loader2 size={14} className="spin" /> : <ArrowRight size={15} />}确认并执行</button>}</div><div className="analysis-usage">{record.source === 'llm' ? `解析用量：${record.usage.input_tokens + record.usage.output_tokens} tokens` : '规则解析不消耗模型额度'}<span>执行阶段用量单独记录</span></div>
    </div>}
  </div><aside className="analysis-guide"><div className="panel-title"><ScanText size={16} />需求解析 Agent</div><ol className="workflow"><li><span>1</span><div><strong>提取清晰目标</strong><p>识别问题类型、修改范围与约束。</p></div></li><li><span>2</span><div><strong>补齐关键歧义</strong><p>需要时提问，保留你的补充回答。</p></div></li><li><span>3</span><div><strong>确认后再执行</strong><p>将完整任务说明交给 Coding Agent。</p></div></li></ol><div className="analysis-guide-note"><ShieldCheck size={18} /><p>解析不授予文件或命令权限。代码改动仍需要在执行后单独审阅。</p></div></aside></div>;
}
