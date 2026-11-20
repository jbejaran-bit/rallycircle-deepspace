import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui'

interface Props {
  name?: string | null
  imageUrl?: string | null
}

export function PlayerIdentity({ name, imageUrl }: Props) {
  const label = name?.trim() || 'Player'
  const initials = label.split(/\s+/u).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase()
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Avatar aria-hidden className="size-8 shrink-0">
        {imageUrl?.startsWith('https://') && <AvatarImage src={imageUrl} referrerPolicy="no-referrer" />}
        <AvatarFallback>{initials}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 break-words font-semibold">{label}</span>
    </span>
  )
}
