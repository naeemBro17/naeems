import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useProducts } from '../../contexts/ProductContext';
import { useWishlist } from '../../contexts/WishlistContext';
import { useToast } from '../../hooks/useToast';
import { Modal } from '../shared/Modal';
import { EditDeliveryDetailsSheet } from './EditDeliveryDetailsSheet';
import { AccountMoreList } from './AccountMoreList';
import { fetchMyOrders, fetchOrderDetail } from '../../lib/orders';
import { formatTaka, initialsOf } from '../../lib/format';
import { openExternal, whatsAppUrl } from '../../lib/expertLinks';
import { navigateBack } from '../../lib/viewTransition';
import { greetingFor, greetingName, memberSince } from '../../lib/greeting';
import type { Order, OrderItem, OrderStatus } from '../../types';
import {
  BackIcon, ChevronIcon, ClockIcon, HeartLineIcon, HelpIcon, LogOutIcon, MoonIcon, OrdersIcon, PinIcon, SkinIcon, StarIcon, SunIcon,
} from './b68Icons';
import { skinProfileOf, type SkinProfile } from '../../lib/routine';

/** Batch 72: "Combination · Acne, Hyperpigmentation" (a missing part skipped). */
export function skinSummary(skin: SkinProfile): string {
  const concerns = skin.concerns.slice(0, 2).join(', ');
  return [skin.skinType ?? '', concerns].filter((part) => part !== '').join(' · ') || 'Get products picked for you';
}

// The pill on the Latest order card, and how far along the 4-step bar is.
const PILL: Record<OrderStatus, string> = {
  pending: 'Placed',
  confirmed: 'Confirmed',
  shipped: 'On the way',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  returned: 'Returned',
};
const STEP: Record<OrderStatus, number> = { pending: 1, confirmed: 2, shipped: 3, delivered: 4, cancelled: 0, returned: 0 };
const STEPS = ['Placed', 'Confirmed', 'Shipped', 'Delivered'];

function areaLine(phone: string | null, thana: string | null, district: string | null): string {
  return [phone, [thana, district].filter((v): v is string => Boolean(v)).join(', ')].filter((v): v is string => Boolean(v)).join(' · ');
}

export function AccountHome({
  wallet,
  preordersOpen,
  onOpenPreorders,
}: {
  wallet: ReactNode;
  preordersOpen: boolean;
  onOpenPreorders: () => void;
}) {
  const { profile, signOut, isCustomer } = useAuth();
  const { settings, products } = useProducts();
  const { ids: wishIds, ready: wishReady } = useWishlist();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isLogoutOpen, setIsLogoutOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [hour, setHour] = useState(() => new Date().getHours());
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [latestItems, setLatestItems] = useState<OrderItem[]>([]);

  // Greeting follows the clock while the page stays open.
  useEffect(() => {
    const id = window.setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // My orders (list), then the newest one's items for the small photos.
  useEffect(() => {
    let live = true;
    void fetchMyOrders().then(async (list) => {
      if (!live) return;
      setOrders(list);
      const latest = list[0];
      if (!latest) return;
      const detail = await fetchOrderDetail(latest.id);
      if (live && detail) setLatestItems(detail.items);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!profile) return null;

  const name = profile.full_name || '';
  const greet = greetingFor(hour);
  const since = memberSince(profile.created_at);
  // Hidden or deleted products are not counted (the Wishlist page drops them).
  const wishCount = wishReady ? wishIds.filter((id) => products.some((p) => p.id === id && p.is_active)).length : 0;
  const orderCount = orders ? orders.filter((o) => o.status !== 'cancelled').length : null;
  const latest = orders && orders.length > 0 ? orders[0] : null;
  const pieces = latestItems.reduce((sum, item) => sum + item.quantity, 0);
  const area = areaLine(profile.phone, profile.thana, profile.district);
  const skin = skinProfileOf(profile);
  const waLink = whatsAppUrl(settings.expert_whatsapp_url);
  const step = latest ? STEP[latest.status] : 0;

  const handleLogout = async () => {
    setIsSigningOut(true);
    await signOut();
    setIsSigningOut(false);
    setIsLogoutOpen(false);
    showToast('Signed out', 'info');
  };

  return (
    <div className="b68 b68-acct" data-testid="account-home">
      <div className="b68-aura" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <div className="b68-atop">
        <button type="button" className="b68-fab" onClick={() => navigateBack(navigate)} aria-label="Go back">
          <BackIcon />
        </button>
        {since !== '' && (
          <span className="b68-mem" data-testid="account-member-since">
            <StarIcon />
            Member since {since}
          </span>
        )}
      </div>

      <div className="b68-me">
        <div className="b68-av">
          {profile.photo_url && !photoFailed ? (
            <img src={profile.photo_url} alt="" onError={() => setPhotoFailed(true)} />
          ) : (
            <span aria-hidden="true">{initialsOf(name || 'Skincare fan')}</span>
          )}
        </div>
        <div>
          <h1 className="b68-hi" data-testid="account-hi">HI {greetingName(name)}</h1>
          <p className="b68-gm" data-testid="account-greeting">
            {greet.text}
            {greet.icon === 'sun' ? <SunIcon /> : <MoonIcon />}
          </p>
        </div>
      </div>

      <div className="b68-body">
        {latest && (
          <Link to={`/orders/${latest.id}`} className="b68-card" data-testid="account-latest-order">
            <div className="b68-lh">
              <small>Latest order</small>
              <span>
                Track
                <ChevronIcon size={16} />
              </span>
            </div>
            <div className="b68-lm">
              <div className="b68-thumbs" aria-hidden="true">
                {latestItems.slice(0, 3).map((item) => (
                  <span key={item.id}>{item.image_url && <img src={item.image_url} alt="" loading="lazy" decoding="async" />}</span>
                ))}
              </div>
              <div>
                <b>{latest.order_number}</b>
                <em>
                  {pieces > 0 ? `${pieces} ${pieces === 1 ? 'item' : 'items'} · ` : ''}
                  {formatTaka(latest.total)}
                </em>
              </div>
              <span className={`b68-pill${latest.status === 'shipped' ? ' b68-pill--live' : ''}`}>
                <i />
                {PILL[latest.status]}
              </span>
            </div>
            {step > 0 && (
              <>
                <div className="b68-trk" aria-hidden="true">
                  {STEPS.map((label, i) => (
                    <i key={label} className={i < step ? 'on' : undefined} />
                  ))}
                </div>
                <div className="b68-tl">
                  {STEPS.map((label, i) => (
                    <span key={label} className={i < step ? 'on' : undefined}>
                      {label}
                    </span>
                  ))}
                </div>
              </>
            )}
          </Link>
        )}

        <div className="b68-tiles">
          <Link to="/orders" className="b68-card b68-tile" data-testid="account-orders">
            <div className="b68-tile__r">
              <span className="b68-ic">
                <OrdersIcon />
              </span>
              {orderCount !== null && <span className="b68-tile__n">{orderCount}</span>}
            </div>
            <span>
              <b>My Orders</b>
              <small>Track and manage</small>
            </span>
          </Link>
          <Link to="/wishlist" className="b68-card b68-tile" data-testid="account-wishlist">
            <div className="b68-tile__r">
              <span className="b68-ic">
                <HeartLineIcon />
              </span>
              <span className="b68-tile__n" data-testid="account-wishlist-count">{wishCount}</span>
            </div>
            <span>
              <b>Wishlist</b>
              <small>Saved for later</small>
            </span>
          </Link>
        </div>

        {wallet}

        <div className="b68-card b68-list" data-testid="account-list">
          {/* Batch 72: only once migration-064 has added the skin fields. */}
          {isCustomer && 'skin_type' in profile && (
            <Link to="/my-skin" className="b68-li" data-testid="account-my-skin">
              <span className="b68-ic">
                <SkinIcon />
              </span>
              <span>
                <b>My skin</b>
                <small>{skin ? skinSummary(skin) : 'Get products picked for you'}</small>
              </span>
              <span className="b68-chv">
                <ChevronIcon size={18} />
              </span>
            </Link>
          )}
          <button type="button" className="b68-li" onClick={() => setIsEditOpen(true)} data-testid="account-delivery">
            <span className="b68-ic">
              <PinIcon />
            </span>
            <span>
              <b>Delivery details</b>
              <small>{area !== '' ? area : 'Add your address for a faster checkout'}</small>
            </span>
            <span className="b68-chv">
              <ChevronIcon size={18} />
            </span>
          </button>
          <button type="button" className="b68-li" onClick={onOpenPreorders} data-testid="account-preorders" aria-expanded={preordersOpen}>
            <span className="b68-ic">
              <ClockIcon />
            </span>
            <span>
              <b>Pre-orders</b>
            </span>
            <span className="b68-soon">COMING SOON</span>
          </button>
          {waLink && (
            <button type="button" className="b68-li" onClick={() => openExternal(waLink)}>
              <span className="b68-ic">
                <HelpIcon />
              </span>
              <span>
                <b>Need help?</b>
                <small>Chat with us on WhatsApp</small>
              </span>
              <span className="b68-chv">
                <ChevronIcon size={18} />
              </span>
            </button>
          )}
        </div>

        <AccountMoreList />

        <button type="button" className="b68-out" onClick={() => setIsLogoutOpen(true)}>
          <LogOutIcon />
          Log out
        </button>
      </div>

      <EditDeliveryDetailsSheet isOpen={isEditOpen} onClose={() => setIsEditOpen(false)} />

      <Modal isOpen={isLogoutOpen} onClose={() => setIsLogoutOpen(false)} title="Log out?">
        <p className="confirm-message">You can sign back in with Google any time.</p>
        <div className="confirm-actions">
          <button type="button" className="button button--secondary" onClick={() => setIsLogoutOpen(false)} disabled={isSigningOut}>
            Cancel
          </button>
          <button type="button" className="button button--secondary" onClick={handleLogout} disabled={isSigningOut}>
            {isSigningOut ? <span className="spinner" aria-hidden="true" /> : 'Log out'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
