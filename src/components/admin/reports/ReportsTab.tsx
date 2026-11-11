import { useNavigate } from 'react-router-dom';
import { adminPath } from '../../../lib/adminPages';
import { AdminPageHeader, ListGroup, ListRow } from '../ui/AdminUi';
import { REPORTS, useReportsNav } from './reportsNav';
import {
  ChartsView,
  CustomersReportView,
  DayBookView,
  ExpensesReportView,
  InvestorsView,
  LotsView,
  ProductsView,
  ProfitLossView,
  SalesView,
  StockView,
} from './ReportViews';
import '../../../styles/adminInventory.css';
import '../../../styles/adminMoney.css';
import '../../../styles/adminReports.css';

/**
 * Admin → Reports (Batch 42): one menu of reports, each with the same date
 * presets, Download Excel and Print / PDF. Only with "View profit & costs"
 * (the database answers nobody else). Every profit number comes from the
 * Batch 39 / 41 functions — the same ones as the Money page.
 */
export function ReportsTab() {
  const navigate = useNavigate();
  const { report, open, back } = useReportsNav();
  const openOrder = (orderNumber: string) => navigate(adminPath.order(orderNumber), { state: { fromList: true } });

  switch (report) {
    case 'pnl':
      return <ProfitLossView onBack={back} />;
    case 'sales':
      return <SalesView onBack={back} onOpenOrder={openOrder} />;
    case 'products':
      return <ProductsView onBack={back} />;
    case 'lots':
      return <LotsView onBack={back} />;
    case 'stock':
      return <StockView onBack={back} />;
    case 'expenses':
      return <ExpensesReportView onBack={back} />;
    case 'customers':
      return <CustomersReportView onBack={back} />;
    case 'daybook':
      return <DayBookView onBack={back} />;
    case 'investors':
      return <InvestorsView onBack={back} />;
    case 'charts':
      return <ChartsView onBack={back} />;
    default:
      return (
        <section className="rep" aria-label="Reports">
          <AdminPageHeader title="Reports" subtitle="Every number here comes from the same sums as the Money page." />
          <ListGroup title="REPORTS">
            {REPORTS.map((r) => (
              <ListRow key={r.id} icon="chart" label={<span data-testid={`report-row-${r.id}`}>{r.label}</span>} detail={r.hint} onClick={() => open(r.id)} />
            ))}
          </ListGroup>
          <ListGroup title="EVERY MONTH">
            <ListRow icon="restock" label="Monthly stock count" onClick={() => navigate({ search: '?tab=money&m=stock-count' })} />
            <ListRow icon="lock" label="Lock a month" onClick={() => navigate({ search: '?tab=money&m=lock' })} />
          </ListGroup>
        </section>
      );
  }
}
