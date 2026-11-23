'use client'

import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Mic, MicOff, Phone, PhoneOff, X } from 'lucide-react'
import { useI18n } from '@/components/i18n-provider'
import { Button } from '@/components/ui/button'
import { createRealtimeClient } from '@/lib/supabase'

type VoiceSignal = {
  type: 'invite' | 'join' | 'leave' | 'end' | 'decline' | 'offer' | 'answer' | 'ice'
  callId: string
  from: string
  to?: string
  name?: string
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

type IncomingCall = { callId: string; from: string; name: string }
type Peer = { connection: RTCPeerConnection; pendingCandidates: RTCIceCandidateInit[] }
type RealtimeClient = Awaited<ReturnType<typeof createRealtimeClient>>

const RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
}

export function GroupAudioCall({
  conversationId,
  currentUserId,
  currentUserName,
  groupName,
}: {
  conversationId: number
  currentUserId: string
  currentUserName: string
  groupName: string
}) {
  const { t } = useI18n()
  const channelRef = useRef<ReturnType<RealtimeClient['channel']> | null>(null)
  const clientRef = useRef<RealtimeClient | null>(null)
  const callIdRef = useRef<string | null>(null)
  const incomingCallRef = useRef<IncomingCall | null>(null)
  const ownerRef = useRef(false)
  const streamRef = useRef<MediaStream | null>(null)
  const peersRef = useRef(new Map<string, Peer>())
  const [channelReady, setChannelReady] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const [participantNames, setParticipantNames] = useState<Record<string, string>>({})
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({})
  const [muted, setMuted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [callError, setCallError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function sendSignal(signal: VoiceSignal) {
    const channel = channelRef.current
    if (!channel) throw new Error('VOICE_CHANNEL_UNAVAILABLE')
    const status = await channel.send({
      type: 'broadcast',
      event: 'voice',
      payload: signal,
    })
    if (status !== 'ok') throw new Error('VOICE_SIGNAL_FAILED')
  }

  function removePeer(userId: string) {
    const peer = peersRef.current.get(userId)
    if (peer) {
      peer.connection.ontrack = null
      peer.connection.onicecandidate = null
      peer.connection.close()
      peersRef.current.delete(userId)
    }
    setRemoteStreams((streams) => {
      const next = { ...streams }
      delete next[userId]
      return next
    })
    setParticipantNames((names) => {
      const next = { ...names }
      delete next[userId]
      return next
    })
  }

  function stopCall() {
    for (const peer of peersRef.current.values()) peer.connection.close()
    peersRef.current.clear()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    callIdRef.current = null
    ownerRef.current = false
    incomingCallRef.current = null
    setCallId(null)
    setIncomingCall(null)
    setParticipantNames({})
    setRemoteStreams({})
    setMuted(false)
  }

  async function ensurePeer(userId: string, name: string) {
    const existing = peersRef.current.get(userId)
    if (existing) return existing

    const connection = new RTCPeerConnection(RTC_CONFIGURATION)
    const peer = { connection, pendingCandidates: [] as RTCIceCandidateInit[] }
    peersRef.current.set(userId, peer)
    for (const track of streamRef.current?.getTracks() ?? []) {
      connection.addTrack(track, streamRef.current!)
    }
    connection.onicecandidate = (event) => {
      if (event.candidate && callIdRef.current) {
        void sendSignal({
          type: 'ice',
          callId: callIdRef.current,
          from: currentUserId,
          to: userId,
          candidate: event.candidate.toJSON(),
        }).catch(() => setCallError(t.chat.voiceSignalFailed))
      }
    }
    connection.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track])
      setRemoteStreams((streams) => ({ ...streams, [userId]: stream }))
      setParticipantNames((names) => ({ ...names, [userId]: name || names[userId] || t.chat.groupCallMember }))
    }
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed') setCallError(t.chat.voiceConnectionFailed)
    }
    return peer
  }

  async function flushCandidates(peer: Peer) {
    const pending = peer.pendingCandidates.splice(0)
    for (const candidate of pending) await peer.connection.addIceCandidate(candidate)
  }

  async function receiveSignal(value: unknown) {
    if (!value || typeof value !== 'object') return
    const signal = value as VoiceSignal
    if (
      !signal.callId ||
      !signal.from ||
      signal.from === currentUserId ||
      (signal.to && signal.to !== currentUserId)
    ) return

    if (signal.type === 'invite') {
      if (!callIdRef.current && !incomingCallRef.current) {
        const invite = { callId: signal.callId, from: signal.from, name: signal.name || t.chat.groupCallMember }
        incomingCallRef.current = invite
        setIncomingCall(invite)
        setPanelOpen(true)
      }
      return
    }

    if (signal.type === 'end') {
      if (callIdRef.current === signal.callId || incomingCallRef.current?.callId === signal.callId) {
        stopCall()
        setPanelOpen(false)
        setNotice(t.chat.groupCallEnded)
      }
      return
    }

    if (signal.type === 'decline') {
      if (callIdRef.current === signal.callId && ownerRef.current) setNotice(t.chat.groupCallDeclined)
      return
    }

    if (signal.type === 'leave') {
      if (callIdRef.current === signal.callId) removePeer(signal.from)
      return
    }

    if (callIdRef.current !== signal.callId || !streamRef.current) return

    setParticipantNames((names) => ({ ...names, [signal.from]: signal.name || names[signal.from] || t.chat.groupCallMember }))

    if (signal.type === 'join') {
      const peer = await ensurePeer(signal.from, signal.name || t.chat.groupCallMember)
      if ((ownerRef.current || currentUserId.localeCompare(signal.from) < 0) && peer.connection.signalingState === 'stable') {
        const offer = await peer.connection.createOffer()
        await peer.connection.setLocalDescription(offer)
        await sendSignal({
          type: 'offer',
          callId: signal.callId,
          from: currentUserId,
          to: signal.from,
          name: currentUserName,
          description: peer.connection.localDescription?.toJSON(),
        })
      }
      return
    }

    const peer = await ensurePeer(signal.from, signal.name || t.chat.groupCallMember)
    if (signal.type === 'offer' && signal.description) {
      if (peer.connection.signalingState !== 'stable') return
      await peer.connection.setRemoteDescription(signal.description)
      await flushCandidates(peer)
      const answer = await peer.connection.createAnswer()
      await peer.connection.setLocalDescription(answer)
      await sendSignal({
        type: 'answer',
        callId: signal.callId,
        from: currentUserId,
        to: signal.from,
        name: currentUserName,
        description: peer.connection.localDescription?.toJSON(),
      })
    } else if (signal.type === 'answer' && signal.description) {
      if (peer.connection.signalingState !== 'have-local-offer') return
      await peer.connection.setRemoteDescription(signal.description)
      await flushCandidates(peer)
    } else if (signal.type === 'ice' && signal.candidate) {
      if (peer.connection.remoteDescription) await peer.connection.addIceCandidate(signal.candidate)
      else peer.pendingCandidates.push(signal.candidate)
    }
  }

  useEffect(() => {
    let disposed = false
    void createRealtimeClient().then((client) => {
      if (disposed) return
      const channel = client
        .channel(`message-group-call:${conversationId}`, { config: { private: true } })
        .on('broadcast', { event: 'voice' }, ({ payload }) => {
          void receiveSignal(payload).catch(() => setCallError(t.chat.voiceSignalFailed))
        })

      clientRef.current = client
      channelRef.current = channel
      channel.subscribe((status) => {
        if (disposed) return
        setChannelReady(status === 'SUBSCRIBED')
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setCallError(t.chat.voiceUnavailable)
      })
    }).catch(() => {
      if (!disposed) setCallError(t.chat.voiceUnavailable)
    })

    return () => {
      disposed = true
      const channel = channelRef.current
      const client = clientRef.current
      const activeCallId = callIdRef.current
      const endingType = ownerRef.current ? 'end' : 'leave'
      if (activeCallId && channel) {
        void channel.send({
          type: 'broadcast',
          event: 'voice',
          payload: { type: endingType, callId: activeCallId, from: currentUserId },
        })
      }
      stopCall()
      channelRef.current = null
      clientRef.current = null
      if (client && channel) void client.removeChannel(channel)
    }
  }, [conversationId, currentUserId, currentUserName])

  async function getMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('MICROPHONE_UNAVAILABLE')
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
  }

  async function startCall() {
    if (!channelReady || busy || callIdRef.current) return
    setBusy(true)
    setCallError(null)
    setNotice(null)
    try {
      streamRef.current = await getMicrophone()
      const id = crypto.randomUUID()
      callIdRef.current = id
      ownerRef.current = true
      setCallId(id)
      setPanelOpen(true)
      await sendSignal({ type: 'invite', callId: id, from: currentUserId, name: currentUserName })
    } catch (error) {
      stopCall()
      setCallError(error instanceof Error && error.message === 'MICROPHONE_UNAVAILABLE'
        ? t.chat.microphoneUnavailable
        : t.chat.microphonePermission)
    } finally {
      setBusy(false)
    }
  }

  async function acceptCall() {
    const invitation = incomingCallRef.current
    if (!invitation || busy) return
    setBusy(true)
    setCallError(null)
    try {
      streamRef.current = await getMicrophone()
      callIdRef.current = invitation.callId
      ownerRef.current = false
      setCallId(invitation.callId)
      incomingCallRef.current = null
      setIncomingCall(null)
      setParticipantNames({ [invitation.from]: invitation.name })
      await sendSignal({ type: 'join', callId: invitation.callId, from: currentUserId, name: currentUserName })
    } catch (error) {
      stopCall()
      setCallError(error instanceof Error && error.message === 'MICROPHONE_UNAVAILABLE'
        ? t.chat.microphoneUnavailable
        : t.chat.microphonePermission)
    } finally {
      setBusy(false)
    }
  }

  async function declineCall() {
    const invitation = incomingCallRef.current
    if (!invitation) return
    incomingCallRef.current = null
    setIncomingCall(null)
    setPanelOpen(false)
    await sendSignal({
      type: 'decline',
      callId: invitation.callId,
      from: currentUserId,
      to: invitation.from,
    }).catch(() => undefined)
  }

  async function hangUp() {
    const activeCallId = callIdRef.current
    if (activeCallId) {
      await sendSignal({
        type: ownerRef.current ? 'end' : 'leave',
        callId: activeCallId,
        from: currentUserId,
      }).catch(() => undefined)
    }
    stopCall()
    setPanelOpen(false)
  }

  function toggleMute() {
    const nextMuted = !muted
    for (const track of streamRef.current?.getAudioTracks() ?? []) track.enabled = !nextMuted
    setMuted(nextMuted)
  }

  const visible = panelOpen || incomingCall !== null || callId !== null
  const names = callId
    ? [currentUserName, ...Object.values(participantNames)]
    : []

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        disabled={!channelReady && !callId}
        onClick={() => {
          setNotice(null)
          setPanelOpen(true)
        }}
        aria-label={t.chat.groupVoiceChat}
        title={t.chat.groupVoiceChat}
      >
        <Phone />
      </Button>

      {visible && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby={`group-call-title-${conversationId}`} onClick={() => !callId && !incomingCall && setPanelOpen(false)}>
          <section className="w-full max-w-sm rounded-t-3xl border bg-background p-5 shadow-2xl sm:rounded-3xl" onClick={(event) => event.stopPropagation()}>
            <header className="mb-4 flex items-center gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Phone className="size-5" /></div>
              <div className="min-w-0 flex-1">
                <h2 id={`group-call-title-${conversationId}`} className="truncate font-semibold">{t.chat.groupVoiceChat}</h2>
                <p className="truncate text-xs text-muted-foreground">{groupName}</p>
              </div>
              {!callId && !incomingCall && <Button variant="ghost" size="icon" aria-label={t.chat.close} onClick={() => setPanelOpen(false)}><X /></Button>}
            </header>

            {incomingCall ? (
              <div className="grid gap-3 text-center">
                <p className="text-sm text-muted-foreground">{t.chat.groupCallIncoming(incomingCall.name)}</p>
                <div className="flex gap-2">
                  <Button className="flex-1" disabled={busy} onClick={() => void acceptCall()}>
                    {busy ? <LoaderCircle className="me-2 size-4 animate-spin" /> : <Phone className="me-2 size-4" />}{busy ? t.chat.groupCallConnecting : t.chat.groupCallJoin}
                  </Button>
                  <Button className="flex-1" variant="outline" onClick={() => void declineCall()}>{t.chat.groupCallDecline}</Button>
                </div>
              </div>
            ) : callId ? (
              <div className="grid gap-4 text-center">
                <p className="text-sm text-muted-foreground">{t.chat.groupCallParticipants(names.length)}</p>
                <ul className="flex flex-wrap justify-center gap-2">
                  {names.map((name, index) => <li key={`${name}-${index}`} className="rounded-full border px-3 py-1.5 text-xs">{name}</li>)}
                </ul>
                <div className="flex justify-center gap-3">
                  <Button type="button" variant={muted ? 'secondary' : 'outline'} size="icon-lg" aria-label={muted ? t.chat.unmuteCall : t.chat.muteCall} onClick={toggleMute}>{muted ? <MicOff /> : <Mic />}</Button>
                  <Button type="button" variant="destructive" size="icon-lg" aria-label={t.chat.groupCallLeave} onClick={() => void hangUp()}><PhoneOff /></Button>
                </div>
              </div>
            ) : (
              <div className="grid gap-3 text-center">
                <p className="text-sm text-muted-foreground">{t.chat.groupCallHint}</p>
                <Button disabled={!channelReady || busy} onClick={() => void startCall()}>
                  {busy ? <LoaderCircle className="me-2 size-4 animate-spin" /> : <Phone className="me-2 size-4" />}
                  {busy ? t.chat.groupCallConnecting : t.chat.groupCallStart}
                </Button>
              </div>
            )}

            {!channelReady && !callId && <p role="status" className="mt-3 text-center text-xs text-muted-foreground">{t.chat.groupCallConnecting}</p>}
            {callError && <p role="alert" className="mt-3 text-center text-xs text-destructive">{callError}</p>}
            {notice && <p role="status" className="mt-3 text-center text-xs text-muted-foreground">{notice}</p>}
          </section>
        </div>
      )}

      {Object.entries(remoteStreams).map(([userId, stream]) => <RemoteAudio key={userId} stream={stream} />)}
    </>
  )
}

function RemoteAudio({ stream }: { stream: MediaStream }) {
  const audioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.srcObject = stream
    void audio.play().catch(() => undefined)
    return () => { audio.srcObject = null }
  }, [stream])

  return <audio ref={audioRef} autoPlay playsInline className="sr-only" />
}
