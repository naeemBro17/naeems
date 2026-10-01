import { groupNavItems, type AdminSection, type NavItem } from '../../lib/adminNav';
import { AdminPageHeader, ListGroup, ListRow } from './ui/AdminUi';

interface MoreTabProps {
  /** Everything this person may open that isn't in the bottom bar. */
  items: readonly NavItem[];
  username: string | null;
  onOpen: (section: AdminSection) => void;
}

/**
 * Admin → More (Batch 25 Part 1, mockup screen 2): on a phone, everything
 * that isn't one of the bottom tabs, in the same groups as the computer's
 * sidebar. Staff only see what their role allows; an empty group is hidden.
 */
export function MoreTab({ items, username, onOpen }: MoreTabProps) {
  const groups = groupNavItems(items);
  return (
    <section aria-label="More" className="adm-more">
      <AdminPageHeader title="More" />
      {groups.map(({ group, items: groupItems }) => (
        <ListGroup key={group.id} title={group.moreLabel ?? (group.label || undefined)}>
          {groupItems.map((item) => (
            <ListRow
              key={item.id}
              icon={item.icon}
              label={item.moreLabel ?? item.label}
              pill={item.superAdminOnly ? 'Super Admin' : undefined}
              onClick={() => onOpen(item.id)}
            />
          ))}
        </ListGroup>
      ))}
      <ListGroup>
        <ListRow icon="eye" label="View site" href="/" />
      </ListGroup>
      {username && (
        <p className="adm-more__user">
          Signed in as <span className="adm-signed-in">{username}</span>
        </p>
      )}
    </section>
  );
}
