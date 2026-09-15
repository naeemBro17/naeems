import { useNavigate } from 'react-router-dom';
import type { BentoTile } from '../../types';
import { isInternalLink } from '../../lib/bentoTiles';

/**
 * One admin-configured card in the bottom-right bento carousel. Internal
 * links (starting with '/') route client-side; everything else opens in a new
 * tab with noopener so the new page can't reach back through window.opener.
 */
export function BentoCustomTile({ tile }: { tile: BentoTile }) {
  const navigate = useNavigate();

  const open = () => {
    if (isInternalLink(tile.link_url)) {
      navigate(tile.link_url);
      return;
    }
    window.open(tile.link_url, '_blank', 'noopener,noreferrer');
  };

  const rawImage = tile.image_url?.trim() ?? '';
  const hasImage = rawImage !== '';
  // Quotes/backslashes/newlines would break out of the url() literal.
  const safeImage = rawImage.replace(/["\\\r\n]/g, '');

  return (
    <button
      type="button"
      className={`bento-custom${hasImage ? ' bento-custom--image' : ''}`}
      onClick={open}
      style={hasImage ? { backgroundImage: `url("${safeImage}")` } : undefined}
    >
      <span className="bento-custom__title">{tile.title}</span>
      {tile.subtitle && tile.subtitle.trim() !== '' && (
        <span className="bento-custom__subtitle">{tile.subtitle}</span>
      )}
    </button>
  );
}
