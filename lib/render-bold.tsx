import { Fragment, type ReactNode } from 'react'

// Turns **text** into real bold, and drops stray single * markers around words.
export function renderBold(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+?\*\*)/g).map((part, index) => {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index} className="font-bold">{part.slice(2, -2)}</strong>
    }
    return <Fragment key={index}>{part.replace(/(^|\s)\*(\S[^*\n]*?)\*(?=\s|$|[.,!?؟،])/g, '$1$2')}</Fragment>
  })
}
