import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';
import { adminPath } from '../../../lib/adminPages';
import { KIND_GROUPS } from '../../../lib/money/format';
import type { EntryKind } from '../../../lib/money/types';
import { useMoneyNav } from './moneyNav';
import { MoneyPage } from './MoneyPage';
import { AddMoneyView } from './AddMoneyView';
import { AccountLedgerView, AccountsView } from './AccountsView';
import { EntryView } from './EntryView';
import { CategoriesView, ExpensesView } from './ExpensesView';
import { PeopleView } from './PeopleView';
import { OpeningView } from './OpeningView';
import { CountView } from './CountView';
import { WriteOffsView } from './WriteOffsView';
import { StockCountView } from './StockCountView';
import { MonthLockView } from './MonthLockView';
import '../../../styles/adminInventory.css';
import '../../../styles/adminMoney.css';

const KINDS = new Set<string>(KIND_GROUPS.flatMap((g) => g.choices.map((c) => c.kind)));

/**
 * Admin → Money (Batch 41): accounts, expenses, investors, owner, dues,
 * opening balances, write-offs and the Money page. "View profit & costs"
 * opens everything (the database shows these numbers to nobody else); "Add
 * money entries" alone opens only the Add money form.
 */
export function MoneyTab() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { view, id, open, back } = useMoneyNav();
  const openOrder = (orderNumber: string) => navigate(adminPath.order(orderNumber), { state: { fromList: true } });
  const openLot = (lotId: string) => navigate({ search: `?tab=inventory&inv=lot&lot=${encodeURIComponent(lotId)}` });

  if (!can('view_profit_costs')) return <AddMoneyView />;

  switch (view) {
    case 'add':
      return <AddMoneyView onBack={back} startKind={id && KINDS.has(id) ? (id as EntryKind) : null} />;
    case 'accounts':
      return <AccountsView onBack={back} onOpen={open} />;
    case 'account':
      return id ? <AccountLedgerView key={id} accountId={id} onBack={back} onOpen={open} onOpenOrder={openOrder} /> : <MoneyPage onOpen={open} />;
    case 'entry':
      return id ? <EntryView key={id} entryId={id} onBack={back} /> : <MoneyPage onOpen={open} />;
    case 'expenses':
      return <ExpensesView onBack={back} onOpen={open} />;
    case 'categories':
      return <CategoriesView onBack={back} />;
    case 'people':
      return <PeopleView onBack={back} onOpen={open} onOpenLot={openLot} />;
    case 'opening':
      return <OpeningView onBack={back} />;
    case 'count':
      return <CountView onBack={back} />;
    case 'writeoffs':
      return <WriteOffsView onBack={back} onOpenOrder={openOrder} />;
    case 'stock-count':
      return <StockCountView onBack={back} />;
    case 'lock':
      return <MonthLockView onBack={back} />;
    default:
      return <MoneyPage onOpen={open} />;
  }
}
