import { Compass } from 'lucide-react';
import { usePageTitle } from '@/lib/usePageTitle';
import { ButtonLink } from '@/ui/Button';
import { Card } from '@/ui/Card';

export function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <Card>
      <div className="st-state">
        <Compass size={28} className="st-state__icon" aria-hidden="true" />
        <h1 className="st-state__title">Page not found</h1>
        <p className="st-state__text">The page you asked for does not exist.</p>
        <div className="st-state__actions">
          <ButtonLink variant="primary" to="/">
            Back to fleet overview
          </ButtonLink>
        </div>
      </div>
    </Card>
  );
}
