import { BannerSlidesPanel, ExpertSettingsPanel } from './SettingsTab';
import { TextsPanel } from './SettingsExtraPanels';
import { SubPages, type SubPage } from './ui/SubPages';
import { AccountIntroPicturePanel } from './AccountIntroPicturePanel';
import { BestCombosPanel, ConcernsPanel, ShowOnHomePanel, SkinTipsPanel, VideosPanel } from './HomePagePanels';

/**
 * Admin → Store design → Banner & Texts (Batch 25 Part 1). The home banner,
 * the "Talk to an Expert" page and the editable site texts moved here from
 * Settings — the very same panels and fields, only a new place.
 */
export function BannerTextsTab() {
  const pages: SubPage[] = [
    { id: 'banner', group: 'HOME PAGE', label: 'Banner slides', icon: 'bento', render: () => <BannerSlidesPanel /> },
    { id: 'expert', group: 'HOME PAGE', label: 'Expert page (Talk to an Expert)', icon: 'profile', render: () => <ExpertSettingsPanel /> },
    // Batch 71: the new Home's own content.
    { id: 'home-tips', group: 'HOME PAGE', label: 'Skin tips', icon: 'design', render: () => <SkinTipsPanel /> },
    { id: 'home-show', group: 'HOME PAGE', label: 'Show on Home', icon: 'design', render: () => <ShowOnHomePanel /> },
    { id: 'home-concerns', group: 'HOME PAGE', label: 'Concerns', icon: 'design', render: () => <ConcernsPanel /> },
    { id: 'home-combos', group: 'HOME PAGE', label: 'Best combos', icon: 'design', render: () => <BestCombosPanel /> },
    { id: 'home-videos', group: 'HOME PAGE', label: 'Videos', icon: 'design', render: () => <VideosPanel /> },
    { id: 'account-intro', group: 'ACCOUNT TAB', label: 'Account intro picture', icon: 'profile', render: () => <AccountIntroPicturePanel /> },
    { id: 'texts', group: 'TEXTS', label: 'Site texts (checkout note, trust boxes)', icon: 'design', render: () => <TextsPanel /> },
  ];
  return (
    <section aria-label="Banner and texts">
      <SubPages title="Banner & Texts" param="dset" pages={pages} />
    </section>
  );
}
