import type { ConnectionState } from '@/hooks/useRemoteBrowser';

interface StatusIndicatorProps {
  state: ConnectionState;
  compact?: boolean;
}

const STATE_CONFIG = {
  disconnected: { dot: 'bg-gray-500', text: 'text-gray-400', label: 'Disconnected' },
  connecting:   { dot: 'bg-yellow-400 animate-pulse', text: 'text-yellow-400', label: 'Connecting' },
  connected:    { dot: 'bg-green-400', text: 'text-green-400', label: 'Connected' },
  failed:       { dot: 'bg-red-400', text: 'text-red-400', label: 'Failed' },
} as const;

export function StatusIndicator({ state, compact = false }: StatusIndicatorProps) {
  const cfg = STATE_CONFIG[state];
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-block w-2 h-2 rounded-full ${cfg.dot}`} />
      {!compact && (
        <span className={`text-xs font-medium ${cfg.text}`}>{cfg.label}</span>
      )}
    </div>
  );
}
