import { motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SPRING_MOUSE } from '@/lib/ease'
import { cn } from '@/lib/utils'

type TiltCardProps = { children: ReactNode; className?: string; max?: number }

export function TiltCard({ children, className, max = 5 }: TiltCardProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [canHover, setCanHover] = useState(false)
  const reduce = useReducedMotion()
  const rx = useMotionValue(0)
  const ry = useMotionValue(0)
  const gx = useMotionValue(50)
  const gy = useMotionValue(50)
  const srx = useSpring(rx, SPRING_MOUSE)
  const sry = useSpring(ry, SPRING_MOUSE)
  const enabled = canHover && !reduce
  const transform = useMotionTemplate`perspective(1000px) rotateX(${srx}deg) rotateY(${sry}deg)`
  const glare = useMotionTemplate`radial-gradient(circle at ${gx}% ${gy}%, var(--foreground), transparent 50%)`

  useEffect(() => {
    const query = window.matchMedia('(hover: hover) and (pointer: fine)')
    const update = () => setCanHover(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return <motion.div
    ref={ref}
    className={cn('relative overflow-hidden will-change-transform', className)}
    style={{ transform, transformStyle: 'preserve-3d' }}
    onMouseMove={event => {
      if (!enabled || !ref.current) return
      const rect = ref.current.getBoundingClientRect()
      const x = (event.clientX - rect.left) / rect.width
      const y = (event.clientY - rect.top) / rect.height
      ry.set((x - .5) * max)
      rx.set((.5 - y) * max)
      gx.set(x * 100)
      gy.set(y * 100)
    }}
    onMouseLeave={() => { rx.set(0); ry.set(0) }}
  >
    {children}
    {enabled && <motion.div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.035]" style={{ background: glare }} />}
  </motion.div>
}
