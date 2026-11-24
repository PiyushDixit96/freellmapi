import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { TableHead } from '@/components/ui/table'
import { useI18n } from '@/i18n'
import type { SortState } from '@/lib/table-sort'

// Header cell with a state-aware indicator: unsorted → faded ChevronsUpDown,
// asc → ArrowUp, desc → ArrowDown. Right-aligned columns put the indicator
// LEFT of the label so the label stays flush with its numbers. `aria-sort`
// lives on the <th>, where assistive tech expects it.
export function SortableHeader<C extends string>({ column, label, align = 'left', className, sort, onToggle }: {
  column: C
  label: string
  align?: 'left' | 'right'
  className?: string
  sort: SortState<C>
  onToggle: (col: C) => void
}) {
  const { t } = useI18n()
  const direction = sort?.column === column ? sort.direction : null
  const Indicator = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ChevronsUpDown
  return (
    <TableHead
      className={[align === 'right' ? 'text-right' : '', className].filter(Boolean).join(' ') || undefined}
      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
    >
      <button
        type="button"
        onClick={() => onToggle(column)}
        aria-label={t('analytics.sortBy', { column: label })}
        className={`inline-flex items-center gap-1 select-none rounded px-1 -mx-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        <span className={direction ? 'font-medium text-foreground' : ''}>{label}</span>
        <Indicator className={`size-3 shrink-0 ${direction ? 'text-foreground' : 'text-muted-foreground'}`} aria-hidden="true" />
      </button>
    </TableHead>
  )
}
