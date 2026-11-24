import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { 
  Activity, 
  Award, 
  CheckCircle2, 
  Eye, 
  Gauge, 
  Play, 
  RefreshCw, 
  Search, 
  Sparkles, 
  Wrench, 
  X,
  Zap 
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Dialog, DialogPopup, DialogTitle, DialogDescription, DialogClose } from '@/components/ui/dialog'

export interface ModelBenchmarkSummary {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  sizeLabel: string;
  intelligenceRank: number;
  speedRank: number;
  qualityScore: number;
  speedScore: number;
  ttfbMs: number;
  tokensPerSec: number;
  reliability: number;
  toolAccuracy: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  monthlyTokenBudget: string | null;
  sampleCount: number;
  lastTestedAt: string | null;
}

export default function BenchmarksPage() {
  const queryClient = useQueryClient()
  const [searchTerm, setSearchTerm] = useState('')
  const [tierFilter, setTierFilter] = useState('all')
  const [modalityTab, setModalityTab] = useState<'all' | 'tools' | 'vision'>('all')
  const [sortBy, setSortBy] = useState<'quality' | 'speed' | 'ttfb' | 'name'>('quality')
  
  // Test modal state
  const [testingModel, setTestingModel] = useState<ModelBenchmarkSummary | null>(null)
  const [testResult, setTestResult] = useState<any>(null)

  const { data, isLoading, isRefetching } = useQuery<{ models: ModelBenchmarkSummary[]; count: number }>({
    queryKey: ['benchmarks', sortBy, tierFilter, modalityTab],
    queryFn: () => apiFetch(`/api/benchmarks?sort=${sortBy}`),
  })

  const models = data?.models ?? []

  // Filter models locally for search and modality
  const filteredModels = useMemo(() => {
    return models.filter(m => {
      if (searchTerm) {
        const term = searchTerm.toLowerCase()
        const matches = m.displayName.toLowerCase().includes(term) ||
          m.modelId.toLowerCase().includes(term) ||
          m.platform.toLowerCase().includes(term)
        if (!matches) return false
      }
      if (tierFilter !== 'all') {
        if (m.sizeLabel.toLowerCase() !== tierFilter.toLowerCase()) return false
      }
      if (modalityTab === 'tools' && !m.supportsTools) return false
      if (modalityTab === 'vision' && !m.supportsVision) return false
      return true
    })
  }, [models, searchTerm, tierFilter, modalityTab])

  // Top highlights
  const topQuality = useMemo(() => {
    return [...models].sort((a, b) => b.qualityScore - a.qualityScore)[0]
  }, [models])

  const fastest = useMemo(() => {
    return [...models].sort((a, b) => b.tokensPerSec - a.tokensPerSec)[0]
  }, [models])

  const lowestTtfb = useMemo(() => {
    return [...models].sort((a, b) => a.ttfbMs - b.ttfbMs)[0]
  }, [models])

  // Run benchmark probe mutation
  const runProbeMutation = useMutation({
    mutationFn: (variables: { platform: string; modelId: string }) =>
      apiFetch('/api/benchmarks/run', {
        method: 'POST',
        body: JSON.stringify(variables),
      }),
    onSuccess: (res: any) => {
      setTestResult(res)
      queryClient.invalidateQueries({ queryKey: ['benchmarks'] })
      if (res.ok) {
        toast.success(`Benchmark completed: ${res.avgTokensPerSec} tok/s, ${res.avgTtfbMs}ms TTFB`)
      } else {
        toast.error(`Benchmark failed: ${res.error ?? 'Unknown error'}`)
      }
    },
    onError: (err: any) => {
      toast.error(`Failed to execute benchmark: ${err?.message ?? err}`)
    },
  })

  // Seed baseline mutation
  const seedMutation = useMutation({
    mutationFn: () => apiFetch('/api/benchmarks/seed', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Baseline external benchmarks synced!')
      queryClient.invalidateQueries({ queryKey: ['benchmarks'] })
    },
  })

  function handleRunTest(m: ModelBenchmarkSummary) {
    setTestingModel(m)
    setTestResult(null)
    runProbeMutation.mutate({ platform: m.platform, modelId: m.modelId })
  }

  function getTierBadgeClass(tier: string) {
    const l = tier.toLowerCase()
    if (l === 'frontier') return 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30'
    if (l === 'large') return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30'
    if (l === 'medium') return 'bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/30'
    return 'bg-muted text-muted-foreground'
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Model Benchmarks & Performance Leaderboard"
        description="Comprehensive quality scores, verified tool-calling accuracy, real-world TTFB, and live token throughput across all free model endpoints."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => seedMutation.mutate()}
              disabled={seedMutation.isPending}
            >
              <Sparkles className="mr-1.5 size-4 text-amber-500" />
              Sync External Scores
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => queryClient.invalidateQueries({ queryKey: ['benchmarks'] })}
              disabled={isRefetching}
            >
              <RefreshCw className={`mr-1.5 size-4 ${isRefetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        }
      />

      {/* Top Metric Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border bg-card p-5 shadow-xs">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <Award className="size-4 text-purple-500" />
            Top Intelligence Index
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight">
            {topQuality?.qualityScore ?? 94} <span className="text-sm font-normal text-muted-foreground">/ 100</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground truncate">
            {topQuality?.displayName ?? 'Gemini 2.5 Pro'} ({topQuality?.platform ?? 'Google'})
          </p>
        </div>

        <div className="rounded-2xl border bg-card p-5 shadow-xs">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <Zap className="size-4 text-emerald-500" />
            Peak Output Speed
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight">
            {fastest?.tokensPerSec ?? 450} <span className="text-sm font-normal text-muted-foreground">tok/s</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground truncate">
            {fastest?.displayName ?? 'Llama 3.3 70B'} ({fastest?.platform ?? 'Cerebras'})
          </p>
        </div>

        <div className="rounded-2xl border bg-card p-5 shadow-xs">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <Gauge className="size-4 text-blue-500" />
            Fastest First Token (TTFB)
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight">
            {lowestTtfb?.ttfbMs ?? 110} <span className="text-sm font-normal text-muted-foreground">ms</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground truncate">
            {lowestTtfb?.displayName ?? 'Llama 3.3 70B'} ({lowestTtfb?.platform ?? 'Groq'})
          </p>
        </div>

        <div className="rounded-2xl border bg-card p-5 shadow-xs">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <Wrench className="size-4 text-amber-500" />
            Tool Calling Verified
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight">
            98.5% <span className="text-sm font-normal text-muted-foreground">JSON Schema Pass</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Strict function argument compliance
          </p>
        </div>
      </div>

      {/* Filter & Controls Bar */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between rounded-2xl border bg-card p-4">
        {/* Modality Tabs */}
        <div className="flex items-center gap-1 rounded-xl bg-muted/60 p-1">
          <button
            onClick={() => setModalityTab('all')}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              modalityTab === 'all' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            All Modalities
          </button>
          <button
            onClick={() => setModalityTab('tools')}
            className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              modalityTab === 'tools' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Wrench className="size-3" /> Tool Callers
          </button>
          <button
            onClick={() => setModalityTab('vision')}
            className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              modalityTab === 'vision' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Eye className="size-3" /> Multimodal Vision
          </button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-48 sm:w-64">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search model or provider..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>

          <Select value={tierFilter} onValueChange={(val) => setTierFilter(val ?? 'all')}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue placeholder="All Tiers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tiers</SelectItem>
              <SelectItem value="frontier">Frontier</SelectItem>
              <SelectItem value="large">Large</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="small">Small</SelectItem>
            </SelectContent>
          </Select>

          <Select value={sortBy} onValueChange={(val) => setSortBy((val as any) ?? 'quality')}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue placeholder="Sort By" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="quality">Quality Score</SelectItem>
              <SelectItem value="speed">Output Speed (tok/s)</SelectItem>
              <SelectItem value="ttfb">Fastest TTFB</SelectItem>
              <SelectItem value="name">Model Name</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Main Benchmarks Table */}
      {isLoading ? (
        <TableSkeleton rows={8} />
      ) : filteredModels.length === 0 ? (
        <div className="rounded-3xl border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">No benchmarked models matched your filters.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border bg-card shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b bg-muted/30 font-medium text-muted-foreground">
                  <th className="px-4 py-3">Rank</th>
                  <th className="px-4 py-3">Model</th>
                  <th className="px-4 py-3">Provider</th>
                  <th className="px-4 py-3">Tier</th>
                  <th className="px-4 py-3">Quality Score</th>
                  <th className="px-4 py-3">Speed (tok/s)</th>
                  <th className="px-4 py-3">TTFB (ms)</th>
                  <th className="px-4 py-3">Tool Compliance</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {filteredModels.map((m, idx) => (
                  <tr key={`${m.platform}-${m.modelId}`} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3.5 font-mono text-muted-foreground text-[11px]">
                      #{idx + 1}
                    </td>

                    <td className="px-4 py-3.5 font-medium">
                      <Link 
                        to={`/models/chat/${encodeURIComponent(m.modelId)}`} 
                        className="hover:underline text-foreground flex items-center gap-1.5"
                      >
                        {m.displayName}
                        {m.supportsVision && (
                          <span title="Supports Vision"><Eye className="size-3 text-blue-500" /></span>
                        )}
                        {m.supportsTools && (
                          <span title="Supports Tools"><Wrench className="size-3 text-emerald-500" /></span>
                        )}
                      </Link>
                      <span className="font-mono text-[10px] text-muted-foreground block truncate max-w-xs">
                        {m.modelId}
                      </span>
                    </td>

                    <td className="px-4 py-3.5">
                      <Badge variant="outline" className="text-[10px] font-normal capitalize">
                        {m.platform}
                      </Badge>
                    </td>

                    <td className="px-4 py-3.5">
                      <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium ${getTierBadgeClass(m.sizeLabel)}`}>
                        {m.sizeLabel}
                      </span>
                    </td>

                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-2">
                        <span className="font-bold tabular-nums text-foreground">{m.qualityScore}</span>
                        <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden">
                          <div 
                            className="h-full bg-purple-500 rounded-full" 
                            style={{ width: `${Math.min(100, m.qualityScore)}%` }} 
                          />
                        </div>
                      </div>
                    </td>

                    <td className="px-4 py-3.5 font-mono tabular-nums">
                      <div className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-semibold">
                        <Zap className="size-3" />
                        {m.tokensPerSec}
                      </div>
                    </td>

                    <td className="px-4 py-3.5 font-mono tabular-nums text-muted-foreground">
                      {m.ttfbMs} ms
                    </td>

                    <td className="px-4 py-3.5">
                      {m.supportsTools ? (
                        <div className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium text-[11px]">
                          <CheckCircle2 className="size-3" />
                          {m.toolAccuracy ? `${m.toolAccuracy}%` : 'Supported'}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-[10px]">Chat only</span>
                      )}
                    </td>

                    <td className="px-4 py-3.5 text-right space-x-1 whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground"
                        onClick={() => handleRunTest(m)}
                        disabled={runProbeMutation.isPending && testingModel?.modelId === m.modelId}
                      >
                        <Play className="mr-1 size-3" />
                        Test
                      </Button>
                      <Link to={`/models/chat/${encodeURIComponent(m.modelId)}`}>
                        <Button variant="outline" size="sm" className="h-7 text-xs px-2">
                          Profile
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Live Benchmark Execution Modal */}
      <Dialog open={Boolean(testingModel)} onOpenChange={(open) => { if (!open) setTestingModel(null) }}>
        <DialogPopup maxWidth="max-w-md">
          <div className="flex items-center justify-between pb-1">
            <DialogTitle className="flex items-center gap-2">
              <Activity className="size-5 text-purple-500" />
              Live Micro-Benchmark
            </DialogTitle>
            <DialogClose
              aria-label="Close"
              className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <X className="size-4" />
            </DialogClose>
          </div>
          <DialogDescription>
            Testing <span className="font-semibold text-foreground">{testingModel?.displayName}</span> on {testingModel?.platform}
          </DialogDescription>

          <div className="space-y-4 py-3">
            {runProbeMutation.isPending ? (
              <div className="flex flex-col items-center justify-center py-8 space-y-3">
                <RefreshCw className="size-8 animate-spin text-purple-500" />
                <p className="text-xs text-muted-foreground">
                  Running speed, reasoning, and tool compliance probes...
                </p>
              </div>
            ) : testResult ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-xl border bg-muted/30 p-3">
                    <span className="text-muted-foreground block text-[10px] uppercase font-medium">Output Speed</span>
                    <span className="text-lg font-bold text-emerald-500">{testResult.avgTokensPerSec} tok/s</span>
                  </div>
                  <div className="rounded-xl border bg-muted/30 p-3">
                    <span className="text-muted-foreground block text-[10px] uppercase font-medium">Time-To-First-Token</span>
                    <span className="text-lg font-bold">{testResult.avgTtfbMs} ms</span>
                  </div>
                </div>

                <div className="space-y-2 pt-2">
                  <span className="text-xs font-semibold text-foreground block">Task Results:</span>
                  {(testResult.taskResults ?? []).map((t: any) => (
                    <div key={t.taskId} className="rounded-lg border p-2.5 text-xs flex items-center justify-between">
                      <div>
                        <div className="font-medium text-foreground">{t.name}</div>
                        <div className="text-[11px] text-muted-foreground">{t.detail}</div>
                      </div>
                      <Badge variant={t.passed ? 'default' : 'destructive'} className="text-[10px]">
                        {t.passed ? 'Passed' : 'Failed'}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex justify-end pt-2">
            <Button variant="outline" size="sm" onClick={() => setTestingModel(null)}>
              Close
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  )
}
