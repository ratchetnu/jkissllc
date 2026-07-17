// Public surface of the communications layer. Import from here.
//
//   import { dispatchComm, fromBooking } from '@/app/lib/comms'
//   await dispatchComm('BOOKING_CONFIRMED', fromBooking(b), { actor: who.sub })

export * from './events'
export * from './context'
export * from './templates'
export * from './policy'
export * from './optout'
export * from './service'
export * from './adapters'
export * from './automation'
export * from './history'
