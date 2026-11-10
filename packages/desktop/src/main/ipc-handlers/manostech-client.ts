import { Effect } from "effect"
import { ManosTechClientRpcs } from "../../shared/ipc-rpc"
import { ManosTechClientAuth } from "../client-auth"

export const manosTechClientHandlers = ManosTechClientRpcs.toLayer(
  Effect.gen(function* () {
    return ManosTechClientRpcs.of({
      ManosTechClientStatus: () => promise(() => ManosTechClientAuth.getStatus()),
      ManosTechClientLogin: ({ email, password }) =>
        promise(() => ManosTechClientAuth.login(email, password)),
      ManosTechClientChangePassword: ({ next }) =>
        promise(() => ManosTechClientAuth.changePassword(next)),
      ManosTechClientForgotPassword: ({ email }) =>
        promise(() => ManosTechClientAuth.forgotPassword(email)),
      ManosTechClientLogout: () => promise(() => ManosTechClientAuth.logout()),
      ManosTechClientGoogleAvailable: () => promise(() => ManosTechClientAuth.googleAvailable()),
      ManosTechClientGoogleStart: () => promise(() => ManosTechClientAuth.googleStart()),
      ManosTechClientGoogleCancel: () => promise(() => ManosTechClientAuth.googleCancel()),
      ManosTechClientUsage: () => promise(() => ManosTechClientAuth.getClientUsage()),
      ManosTechClientUsageWarned: () =>
        promise(() => {
          ManosTechClientAuth.markUsageWarnedToday()
        }),
      ManosTechClientTranscribe: ({ audio }) => promise(() => ManosTechClientAuth.transcribeAudio(audio)),
    })
  }),
)

function promise<A>(evaluate: () => A | Promise<A>) {
  return Effect.tryPromise(async () => evaluate()).pipe(Effect.orDie)
}
