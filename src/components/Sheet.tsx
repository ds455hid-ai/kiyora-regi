import type { ReactNode } from 'react'

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="row between">
          <div className="h2">{title}</div>
          <button className="btn sm ghost" onClick={onClose}>閉じる</button>
        </div>
        {children}
      </div>
    </div>
  )
}
