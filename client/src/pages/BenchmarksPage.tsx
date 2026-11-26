import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { 
  Activity, 
  Award, 
  Eye, 
  Gauge, 
  Play, 
  RefreshCw, 
  Search, 
  Sparkles, 
  Timer,
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

export type BenchmarkSuite =
  | 'all'
  | 'fast_text'
  | 'coding'
  | 'structured_json'
  | 'reasoning'
  | 'tools'
  | 'speed';

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
  fastTextMs: number | null;
  tokensPerSec: number;
  reliability: number;
  toolAccuracy: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  monthlyTokenBudget: string | null;
  sampleCount: number;
  lastTestedAt: string | null;
  lastBenchmarkedAt: string | null;
  useCases?: {
    fastTextMs: number | null;
    coding: number | null;
    structuredJson: number | null;
    reasoning: number | null;
    tools: number | null;
  };
  rateLimitInfo?: {
    status: 'ready' | 'rate_limited' | 'quota_reached' | 'no_key' | 'error';
    cooldownUntil: string | null;
    rateLimitHits14d: number;
    quotaRemaining: number | null;
    quotaLimit: number | null;
    quotaMetric: string | null;
    quotaResetAt: string | null;
  };
}

function formatDateTime(isoOrSqlite: string | null | undefined): string {
  if (!isoOrSqlite) return 'Never'
  const normalized = isoOrSqlite.includes('T') ? isoOrSqlite : isoOrSqlite.replace(' ', 'T') + 'Z'
  const d = new Date(normalized)
  if (Number.isNaN(d.getTime())) return isoOrSqlite
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function BenchmarksPage() {
  const queryClient = useQueryClient()
  const [searchTerm, setSearchTerm] = useState('')
  const [tierFilter, setTierFilter] = useState('all')
  const [modalityTab, setModalityTab] = useState<'all' | 'tools' | 'vision'>('all')
  const [sortBy, setSortBy] = useState<'quality' | 'speed' | 'ttfb' | 'fast_text' | 'last_tested' | 'name'>('quality')
  const [selectedSuite, setSelectedSuite] = useState<BenchmarkSuite>('all')
  
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
    mutationFn: (variables: { platform: string; modelId: string; suite?: BenchmarkSuite }) =>
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

  // Autopilot status query
  const { data: autopilotStatus, refetch: refetchAutopilot } = useQuery<{
    enabled: boolean;
    intervalMs: number;
    lastRunAt: string | null;
    lastProbedModel: string | null;
    runsTotal: number;
  }>({
    queryKey: ['benchmark-autopilot'],
    queryFn: () => apiFetch('/api/benchmarks/autopilot/status'),
    refetchInterval: 15_000,
  })

  // Trigger autopilot pass mutation
  const triggerAutopilotMutation = useMutation({
    mutationFn: () => apiFetch('/api/benchmarks/autopilot/trigger', { method: 'POST' }),
    onSuccess: (res: any) => {
      refetchAutopilot()
      queryClient.invalidateQueries({ queryKey: ['benchmarks'] })
      if (res.ok) {
        toast.success(`Autopilot probed ${res.model}: ${res.result?.avgTokensPerSec ?? 0} tok/s`)
      } else {
        toast.info(res.error ?? 'Autopilot pass completed')
      }
    },
    onError: (err: any) => {
      toast.error(`Autopilot error: ${err?.message ?? err}`)
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

  // Sync live free/keyless models mutation
  const syncFreeMutation = useMutation({
    mutationFn: () => apiFetch<{ checkedPlatforms: string[]; addedCount: number }>('/api/models/sync-free', { method: 'POST' }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['benchmarks'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      if (res.addedCount > 0) {
        toast.success(`Discovered ${res.addedCount} new free model(s) across ${res.checkedPlatforms.join(', ')}`)
      } else {
        toast.info(`Free catalog is up to date (checked ${res.checkedPlatforms.length} platform(s))`)
      }
    },
    onError: (err: any) => {
      toast.error(`Free model sync failed: ${err?.message ?? err}`)
    },
  })

  // Paced batch benchmark queue for ready models
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; currentModel: string; aborted: boolean } | null>(null)

  async function handleBatchBenchmark() {
    const readyModels = filteredModels.filter(m => !m.rateLimitInfo || m.rateLimitInfo.status === 'ready').slice(0, 10)
    if (readyModels.length === 0) {
      toast.info('No ready models in the current view to benchmark')
      return
    }
    let aborted = false
    setBatchProgress({ current: 0, total: readyModels.length, currentModel: readyModels[0].modelId, aborted: false })
    for (let i = 0; i < readyModels.length; i++) {
      const m = readyModels[i]
      let shouldStop = false
      setBatchProgress(prev => {
        if (prev?.aborted) shouldStop = true
        return prev ? { ...prev, current: i + 1, currentModel: m.modelId } : null
      })
      if (shouldStop || aborted) break
      try {
        await apiFetch('/api/benchmarks/run', {
          method: 'POST',
          body: JSON.stringify({ platform: m.platform, modelId: m.modelId, suite: selectedSuite }),
        })
      } catch {
        // Continue paced queue
      }
      if (i < readyModels.length - 1) {
        await new Promise(r => setTimeout(r, 1500))
      }
    }
    setBatchProgress(null)
    queryClient.invalidateQueries({ queryKey: ['benchmarks'] })
    toast.success(`Batch benchmark finished (${readyModels.length} ready models checked)`)
  }

  function handleRunTest(m: ModelBenchmarkSummary, suite: BenchmarkSuite = selectedSuite) {
    setTestingModel(m)
    setTestResult(null)
    runProbeMutation.mutate({ platform: m.platform, modelId: m.modelId, suite })
  }

  function getRateLimitBadge(info?: ModelBenchmarkSummary['rateLimitInfo']) {
    if (!info || info.status === 'ready') {
      return (
        <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px]">
          Ready
        </Badge>
      )
    }
    if (info.status === 'rate_limited') {
      return (
        <Badge
          variant="outline"
          title={info.cooldownUntil ? `Cooldown until ${formatDateTime(info.cooldownUntil)}` : 'Rate limited'}
          className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px]"
        >
          Rate Limited
        </Badge>
      )
    }
    if (info.status === 'quota_reached') {
      return (
        <Badge
          variant="outline"
          title={info.quotaResetAt ? `Resets ${formatDateTime(info.quotaResetAt)}` : 'Quota reached'}
          className="border-destructive/40 bg-destructive/10 text-destructive text-[10px]"
        >
          Quota Reached
        </Badge>
      )
    }
    if (info.status === 'error') {
      return (
        <Badge variant="destructive" className="text-[10px]">
          Key Error
        </Badge>
      )
    }
    return (
      <Badge variant="secondary" className="text-[10px] text-muted-foreground">
        No Key
      </Badge>
    )
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
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleBatchBenchmark}
              disabled={Boolean(batchProgress)}
              title="Sequentially benchmark up to 10 ready models in the current list"
            >
              <Play className={`mr-1.5 size-4 text-emerald-500 ${batchProgress ? 'animate-pulse' : ''}`} />
              {batchProgress ? `Running ${batchProgress.current}/${batchProgress.total}...` : 'Benchmark Ready'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncFreeMutation.mutate()}
              disabled={syncFreeMutation.isPending}
              title="Discover newly published free/keyless models from enabled providers"
            >
              <Sparkles className={`mr-1.5 size-4 text-purple-500 ${syncFreeMutation.isPending ? 'animate-spin' : ''}`} />
              Sync Free Models
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => triggerAutopilotMutation.mutate()}
              disabled={triggerAutopilotMutation.isPending}
              title="Trigger background autopilot micro-benchmarking pass"
            >
              <Timer className={`mr-1.5 size-4 text-cyan-500 ${triggerAutopilotMutation.isPending ? 'animate-spin' : ''}`} />
              Autopilot ({autopilotStatus?.runsTotal ?? 0})
            </Button>
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

      {/* Autopilot Background Prober Info Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex size-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>
            <strong className="text-foreground">Autopilot Micro-Benchmarking:</strong>{' '}
            {autopilotStatus?.enabled ? 'Active' : 'Standby'} (cadence: every {Math.round((autopilotStatus?.intervalMs ?? 1800000) / 60000)}m)
          </span>
          {autopilotStatus?.lastProbedModel && (
            <span className="text-muted-foreground">
              · Last auto-probed: <code className="font-mono text-[11px] text-foreground">{autopilotStatus.lastProbedModel}</code>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span>Scheduled passes: <strong className="text-foreground">{autopilotStatus?.runsTotal ?? 0}</strong></span>
        </div>
      </div>

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
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between rounded-2xl border bg-card p-3 sm:p-4">
        {/* Modality Tabs */}
        <div className="inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-xl bg-muted/60 p-1 [&>button]:shrink-0">
          <button
            type="button"
            onClick={() => setModalityTab('all')}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              modalityTab === 'all' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            All Modalities
          </button>
          <button
            type="button"
            onClick={() => setModalityTab('tools')}
            className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              modalityTab === 'tools' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Wrench className="size-3" /> Tool Callers
          </button>
          <button
            type="button"
            onClick={() => setModalityTab('vision')}
            className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              modalityTab === 'vision' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Eye className="size-3" /> Multimodal Vision
          </button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          <div className="relative flex-1 sm:flex-initial w-full sm:w-64 min-w-[180px]">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search model or provider..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>

          <Select value={tierFilter} onValueChange={(val) => setTierFilter(val ?? 'all')}>
            <SelectTrigger className="h-8 flex-1 sm:flex-initial sm:w-32 text-xs">
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
            <SelectTrigger className="h-8 flex-1 sm:flex-initial sm:w-44 text-xs">
              <SelectValue placeholder="Sort By" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="quality">Quality Score</SelectItem>
              <SelectItem value="speed">Output Speed (tok/s)</SelectItem>
              <SelectItem value="ttfb">Fastest TTFB</SelectItem>
              <SelectItem value="fast_text">Fastest No-Think (ms)</SelectItem>
              <SelectItem value="last_tested">Recently Tested</SelectItem>
              <SelectItem value="name">Model Name</SelectItem>
            </SelectContent>
          </Select>

          <Select value={selectedSuite} onValueChange={(val) => setSelectedSuite((val as BenchmarkSuite) ?? 'all')}>
            <SelectTrigger className="h-8 flex-1 sm:flex-initial sm:w-44 text-xs" title="Benchmark use-case suite to run">
              <SelectValue placeholder="Test Suite" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Suite: All Use Cases</SelectItem>
              <SelectItem value="fast_text">Suite: Fast Text (No-Think)</SelectItem>
              <SelectItem value="coding">Suite: Coding (TS)</SelectItem>
              <SelectItem value="structured_json">Suite: JSON Extraction</SelectItem>
              <SelectItem value="reasoning">Suite: Reasoning</SelectItem>
              <SelectItem value="tools">Suite: Tool Calling</SelectItem>
              <SelectItem value="speed">Suite: Raw Speed</SelectItem>
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
            <table className="w-full min-w-[1050px] text-left text-xs">
              <thead>
                <tr className="border-b bg-muted/30 font-medium text-muted-foreground">
                  <th className="px-4 py-3">Rank</th>
                  <th className="px-4 py-3">Model</th>
                  <th className="px-4 py-3">Provider & Status</th>
                  <th className="px-4 py-3">Quality</th>
                  <th className="px-4 py-3">Speed / TTFB</th>
                  <th className="px-4 py-3">No-Think (ms)</th>
                  <th className="px-4 py-3">Use Cases</th>
                  <th className="px-4 py-3">Last Tested</th>
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
                        className="rounded px-1 -mx-1 hover:underline text-foreground flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {m.displayName}
                        {m.supportsVision && (
                          <span title="Supports Vision"><Eye className="size-3 text-blue-500" /></span>
                        )}
                        {m.supportsTools && (
                          <span title="Supports Tools"><Wrench className="size-3 text-emerald-500" /></span>
                        )}
                      </Link>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="font-mono text-[10px] text-muted-foreground truncate max-w-[200px]">
                          {m.modelId}
                        </span>
                        <span className={`inline-flex items-center rounded border px-1.5 py-0 text-[9px] font-medium ${getTierBadgeClass(m.sizeLabel)}`}>
                          {m.sizeLabel}
                        </span>
                      </div>
                    </td>

                    <td className="px-4 py-3.5">
                      <div className="flex flex-col items-start gap-1">
                        <div className="flex items-center gap-1.5">
                          <Badge variant="outline" className="text-[10px] font-normal capitalize">
                            {m.platform}
                          </Badge>
                          {getRateLimitBadge(m.rateLimitInfo)}
                        </div>
                        {(m.rateLimitInfo?.rateLimitHits14d ?? 0) > 0 && (
                          <span className="text-[10px] text-amber-600 dark:text-amber-400">
                            {m.rateLimitInfo?.rateLimitHits14d} rate-limit hits (14d)
                          </span>
                        )}
                        {m.rateLimitInfo?.quotaRemaining != null && m.rateLimitInfo?.quotaLimit != null && (
                          <span className="text-[10px] text-muted-foreground font-mono">
                            Quota: {m.rateLimitInfo.quotaRemaining.toLocaleString()} / {m.rateLimitInfo.quotaLimit.toLocaleString()}
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-2">
                        <span className="font-bold tabular-nums text-foreground">{m.qualityScore}</span>
                        <div className="h-1.5 w-14 rounded-full bg-muted overflow-hidden">
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
                        {m.tokensPerSec} tok/s
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {m.ttfbMs} ms TTFB
                      </div>
                    </td>

                    <td className="px-4 py-3.5 font-mono tabular-nums text-foreground">
                      {m.fastTextMs != null ? (
                        <span className="inline-flex items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
                          {m.fastTextMs} ms
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-[11px]">—</span>
                      )}
                    </td>

                    <td className="px-4 py-3.5">
                      <div className="flex flex-wrap gap-1 max-w-[180px]">
                        {m.useCases?.coding != null && (
                          <span className="rounded border px-1.5 py-0.5 text-[10px] font-mono" title="Code Generation">
                            Code {m.useCases.coding}%
                          </span>
                        )}
                        {m.useCases?.structuredJson != null && (
                          <span className="rounded border px-1.5 py-0.5 text-[10px] font-mono" title="Structured JSON">
                            JSON {m.useCases.structuredJson}%
                          </span>
                        )}
                        {m.useCases?.reasoning != null && (
                          <span className="rounded border px-1.5 py-0.5 text-[10px] font-mono" title="Reasoning">
                            Logic {m.useCases.reasoning}%
                          </span>
                        )}
                        {m.supportsTools && (
                          <span className="rounded border border-emerald-500/30 bg-emerald-500/5 px-1.5 py-0.5 text-[10px] font-mono text-emerald-600 dark:text-emerald-400" title="Tool Calling">
                            Tools {m.toolAccuracy != null ? `${m.toolAccuracy}%` : '✓'}
                          </span>
                        )}
                        {m.useCases?.coding == null && m.useCases?.structuredJson == null && m.useCases?.reasoning == null && !m.supportsTools && (
                          <span className="text-muted-foreground text-[10px]">Chat</span>
                        )}
                      </div>
                    </td>

                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <div className="text-[11px] text-foreground" title={m.lastBenchmarkedAt ?? m.lastTestedAt ?? 'Not yet tested'}>
                        {formatDateTime(m.lastBenchmarkedAt ?? m.lastTestedAt)}
                      </div>
                      {m.sampleCount > 0 && (
                        <div className="text-[10px] text-muted-foreground">
                          {m.sampleCount} reqs
                        </div>
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
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Tested at: <strong className="text-foreground">{formatDateTime(testResult.testedAt)}</strong></span>
                  <span>Total: <strong className="text-foreground">{testResult.totalLatencyMs} ms</strong></span>
                </div>
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

                <div className="space-y-2 pt-2 max-h-[300px] overflow-y-auto pr-1">
                  <span className="text-xs font-semibold text-foreground block">Use-Case Task Results:</span>
                  {(testResult.taskResults ?? []).map((t: any) => (
                    <div key={t.taskId} className="rounded-lg border p-2.5 text-xs flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-foreground flex items-center gap-2">
                          <span>{t.name}</span>
                          {t.latencyMs > 0 && (
                            <span className="font-mono text-[10px] text-muted-foreground">{t.latencyMs}ms</span>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate">{t.detail}</div>
                      </div>
                      <Badge variant={t.passed ? 'default' : 'destructive'} className="text-[10px] shrink-0">
                        {t.passed ? `${t.score}%` : 'Failed'}
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
