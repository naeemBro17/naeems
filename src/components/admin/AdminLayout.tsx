import type { ReactNode } from 'react';
import { AdminIcon } from './ui/AdminIcon';
import { groupNavItems, type AdminSection, type NavItem } from '../../lib/adminNav';

interface AdminLayoutProps {
  active: AdminSection;
  /** Sidebar items this person may open (menu order). */
  items: readonly NavItem[];
  /** The phone's bottom bar (5 tabs when there is enough to show). */
  tabs: readonly NavItem[];
  /** "NAEEM'S SUPER ADMIN" / "NAEEM'S MODERATOR". */
  title: string;
  /** Who is signed in (shown at the foot of the sidebar). */
  username: string | null;
  /** Shown above the page (the Safety Lock warning bar). */
  banner?: ReactNode;
  onNavigate: (section: AdminSection) => void;
  /** Orders waiting to be confirmed — the orange badge on Orders. */
  pendingOrders: number;
  children: ReactNode;
}

/**
 * The admin shell (Batch 25 Part 1, mockup screens 1–4): a grouped left
 * sidebar from 1024px up, a 5-tab bottom bar below that. Which items show
 * comes from lib/adminNav.ts.
 */
export function AdminLayout({
  active,
  items,
  tabs,
  title,
  username,
  banner,
  onNavigate,
  pendingOrders,
  children,
}: AdminLayoutProps) {
  const groups = groupNavItems(items);
  const activeTab = tabs.some((t) => t.id === active) ? active : 'more';

  const badge = (item: NavItem) =>
    item.id === 'orders' && pendingOrders > 0 ? (
      <span className="adm-badge" aria-label={`${pendingOrders} to confirm`}>
        {pendingOrders}
      </span>
    ) : null;

  return (
    <div className="adm">
      <aside className="adm-sidebar" aria-label="Admin menu">
        <p className="adm-sidebar__brand">{title}</p>
        <nav aria-label="Admin sections">
          {groups.map(({ group, items: groupItems }) => (
            <div key={group.id} className="adm-sidebar__group">
              {group.label && <p className="adm-sidebar__heading">{group.label}</p>}
              {groupItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`adm-sidebar__item${active === item.id ? ' adm-sidebar__item--on' : ''}`}
                  aria-current={active === item.id ? 'page' : undefined}
                  onClick={() => onNavigate(item.id)}
                >
                  <AdminIcon name={item.icon} />
                  <span className="adm-sidebar__label">{item.label}</span>
                  {badge(item)}
                </button>
              ))}
            </div>
          ))}
        </nav>
        {username && (
          <p className="adm-sidebar__user">
            Signed in as <span className="adm-signed-in">{username}</span>
          </p>
        )}
      </aside>

      <div className="adm-main">
        {banner}
        <main className="adm-content">{children}</main>
      </div>

      <nav className="adm-tabbar" aria-label="Admin sections">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`adm-tabbar__tab${activeTab === tab.id ? ' adm-tabbar__tab--on' : ''}`}
            aria-current={activeTab === tab.id ? 'page' : undefined}
            onClick={() => onNavigate(tab.id)}
          >
            <span className="adm-tabbar__icon">
              <AdminIcon name={tab.icon} />
              {badge(tab)}
            </span>
            <span className="adm-tabbar__label">{tab.tabLabel ?? tab.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
