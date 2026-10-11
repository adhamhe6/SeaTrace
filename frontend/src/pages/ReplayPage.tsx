import { RefreshCw } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useIncidentForAlarm, useIncidentWindow } from '@/api/hooks';
import { ReplaySelector } from '@/features/replay/ReplaySelector';
import { ReplayWorkbench } from '@/features/replay/ReplayWorkbench';
import { parseReplayUrl, sourceToParams, type ReplaySource } from '@/features/replay/urlState';
import { usePageTitle } from '@/lib/usePageTitle';
import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Skeleton } from '@/ui/Skeleton';
import { EmptyState, ErrorState } from '@/ui/states';
import './pages.css';
import '@/features/replay/replay.css';

export default function ReplayPage() {
  usePageTitle('Incident replay');
  const [params, setParams] = useSearchParams();
  const { source, problem } = parseReplayUrl(params);

  const alarmQuery = useIncidentForAlarm(
    source?.kind === 'alarm' ? source.alarmId : null,
    source?.kind === 'alarm' ? source.before : 0,
    source?.kind === 'alarm' ? source.after : 0,
  );
  const windowQuery = useIncidentWindow(
    source?.kind === 'window'
      ? { vessel: source.vessel, equipment: source.equipment, from: source.from, to: source.to }
      : null,
  );
  const query = source?.kind === 'alarm' ? alarmQuery : windowQuery;

  const load = (next: ReplaySource) => {
    setParams(sourceToParams(next));
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div className="page-head__title">
          <h1>Incident replay</h1>
          <p className="page-head__sub">
            Replay stored telemetry, equipment states and alarm events exactly as recorded. Nothing
            is interpolated or invented.
          </p>
        </div>
        {source && query.data ? (
          <div className="page-head__actions">
            <Button
              icon={RefreshCw}
              onClick={() => void query.refetch()}
              loading={query.isFetching}
            >
              Reload data
            </Button>
          </div>
        ) : null}
      </div>

      <ReplaySelector
        key={params.toString()}
        current={source}
        onSubmit={load}
        loading={source !== null && query.isFetching && !query.data}
      />

      {problem ? (
        <Banner tone="warning" role="alert" title="This replay link cannot be used.">
          {problem}
        </Banner>
      ) : null}

      {source === null ? (
        <Card>
          <EmptyState title="No incident selected">
            Choose a vessel, equipment and time range above, or open an alarm and use “Replay
            incident”.
          </EmptyState>
        </Card>
      ) : query.isPending ? (
        <div className="stack" role="status" aria-label="Loading replay data">
          <Skeleton height={80} />
          <Skeleton height={90} />
          <div className="replay-grid">
            <div className="stack">
              <Skeleton height={140} />
              <Skeleton height={140} />
              <Skeleton height={140} />
            </div>
            <Skeleton height={360} />
          </div>
        </div>
      ) : query.isError ? (
        <Card>
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </Card>
      ) : (
        <ReplayWorkbench window={query.data} />
      )}
    </div>
  );
}
