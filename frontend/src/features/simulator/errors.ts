import { ApiError } from '@/api/client';

export interface CommandFailure {
  title: string;
  message: string;
}

/** Maps backend error codes of the simulator endpoints to operator-friendly text. */
export function describeCommandFailure(error: unknown): CommandFailure {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'simulator_unavailable':
        return {
          title: 'Simulator unavailable',
          message:
            'The backend cannot reach the simulator over OPC UA right now. Make sure the simulator is running and the connection is established, then retry.',
        };
      case 'scenario_rejected':
        return {
          title: 'Command rejected by the simulator',
          message:
            error.message ||
            'The simulator did not accept the command (for example the scenario is already in that state).',
        };
      case 'invalid_duration':
        return { title: 'Invalid duration', message: error.message };
      case 'vessel_required':
        return {
          title: 'Vessel required',
          message: 'This scenario acts on one vessel; choose a vessel first.',
        };
      case 'simulator_error':
        return {
          title: 'Simulator protocol error',
          message: 'The simulator rejected the command at protocol level. Check the simulator log.',
        };
      default:
        break;
    }
    if (error.status === 403) {
      return {
        title: 'Operator role required',
        message: 'Your account is read-only. Sign in as an operator to control the simulator.',
      };
    }
    if (error.status === 404) return { title: 'Not found', message: error.message };
    if (error.isNetwork) return { title: 'Server unreachable', message: error.message };
    return { title: 'Command failed', message: error.message };
  }
  return {
    title: 'Command failed',
    message: error instanceof Error ? error.message : 'Unexpected error.',
  };
}
