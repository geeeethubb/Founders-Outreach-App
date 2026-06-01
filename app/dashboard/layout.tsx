import Sidebar from '@/components/layout/Sidebar'

export const dynamic = 'force-dynamic'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar />
      <main className="flex-1 ml-[240px] min-h-screen overflow-auto">
        {children}
      </main>
    </div>
  )
}
