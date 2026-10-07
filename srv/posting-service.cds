// Internal service behind the persistent outbox: not exposed over any protocol (spec §3.5).
// Each message posts one chunk of a job; the handler queues the next chunk until nothing is left.
@protocol: 'none'
service PostingService {
  action postChunk(jobID : UUID);
}
