import { type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AdminPageHeader, ListGroup, ListRow } from './AdminUi';
import type { AdminUiIconName } from './AdminIcon';

export interface SubPage {
  id: string;
  /** Group heading on the list ("ORDERS"). */
  group: string;
  label: string;
  icon: AdminUiIconName;
  /** Grey text on the right of the row. */
  detail?: string;
  render: () => ReactNode;
}

/**
 * A settings-type page (Batch 25): a grouped rounded list; tapping a row
 * opens that item as its own page. The open item lives in the URL
 * (?<param>=<id>), so phone Back returns to the list and refresh keeps it.
 */
export function SubPages({
  title,
  param,
  pages,
  footer,
}: {
  title: string;
  param: string;
  pages: SubPage[];
  /** Extra rows under the list (e.g. Sign out). */
  footer?: ReactNode;
}) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const openId = searchParams.get(param) ?? '';
  const open = pages.find((p) => p.id === openId) ?? null;

  const setOpen = (id: string) => {
    const next = new URLSearchParams(location.search);
    next.set(param, id);
    navigate({ search: `?${next.toString()}` });
    window.scrollTo(0, 0);
  };

  const close = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) {
      navigate(-1);
      return;
    }
    const next = new URLSearchParams(location.search);
    next.delete(param);
    navigate({ search: `?${next.toString()}` }, { replace: true });
  };

  if (open) {
    return (
      <>
        <AdminPageHeader title={open.label} onBack={close} backLabel={`Back to ${title}`} />
        <div className="adm-subpage">{open.render()}</div>
      </>
    );
  }

  const groups: { name: string; pages: SubPage[] }[] = [];
  for (const page of pages) {
    const group = groups.find((g) => g.name === page.group);
    if (group) group.pages.push(page);
    else groups.push({ name: page.group, pages: [page] });
  }

  return (
    <>
      <AdminPageHeader title={title} />
      <div className="adm-settings-list">
        {groups.map((group) => (
          <ListGroup key={group.name} title={group.name}>
            {group.pages.map((page) => (
              <ListRow key={page.id} icon={page.icon} label={page.label} detail={page.detail} onClick={() => setOpen(page.id)} />
            ))}
          </ListGroup>
        ))}
        {footer}
      </div>
    </>
  );
}
