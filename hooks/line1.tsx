// Surface module for line 1: draws the segments in their own colours at rest
// (a Button can't be coloured until hovered) and turns a click on the model
// or effort into a post the hooks module answers by opening that picker, and
// a click on the Slurm job into one that opens the job panel.

import type { ClientModule } from 'claude-code'

import { cellWidth } from './format'
import type { Seg } from './format'

type Props = { segs: Seg[]; plain: string }
type State = { hovered: number | null }

// Which segment the column falls in, by the cells each one takes.
function segAt(segs: Seg[], x: number): number | null {
  let left = 0
  for (let i = 0; i < segs.length; i++) {
    const right = left + cellWidth(segs[i]!.text)
    if (x >= left && x < right) return i
    left = right
  }
  return null
}

const Line1: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const { segs, plain } = props
  const hovered = surface.state?.hovered ?? null

  const open = (i: number | null) => {
    const action = i === null ? undefined : segs[i]?.action
    if (action) surface.post({ open: action })
  }

  surface.onPointer(e => {
    const i = segAt(segs, e.x)
    if (e.type === 'up' && e.button === 'left') open(i)
    const next = e.type === 'leave' || i === null || !segs[i]?.action ? null : i
    if (next !== hovered) surface.setState({ hovered: next })
  })

  // While the band has the focus (ctrl+x tab): m or Enter for the model, e for
  // effort, j for the Slurm job panel.
  surface.onKey(e => {
    if (e.key === 'm' || e.key === 'return') surface.post({ open: 'model' })
    if (e.key === 'e') surface.post({ open: 'effort' })
    if (e.key === 'j' && segs.some(seg => seg.action === 'job')) surface.post({ open: 'job' })
  })

  return (
    <Box flexDirection="row">
      {segs.map((seg, i) => (
        <Text key={String(i)} color={seg.color ?? plain} underline={i === hovered}>
          {seg.text}
        </Text>
      ))}
    </Box>
  )
}

export default Line1
