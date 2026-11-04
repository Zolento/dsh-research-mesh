/** Probe loaded by the real DSH Cordis loader; exercises the Mesh service. */
import { writeFileSync } from 'node:fs';

export const name = 'mesh-loader-probe';
export const inject = ['researchMesh'];

export async function apply(ctx, config) {
  const reportPath = config?.reportPath;
  const result = { ok: false, checks: {}, error: null };
  try {
    const service = ctx.get('researchMesh');
    result.checks.serviceProvided = service !== undefined;
    result.checks.initialized = service?.initialized === true;
    result.checks.projectRoot = service?.config?.projectRoot;
    const team = await service.createTeam({
      projectId: 'proj-loader',
      routeId: 'A',
      name: 'group-a',
      rootSessionId: 'root-loader',
    });
    result.checks.teamStatus = team.status;
    const task = service.submitTask({
      projectId: 'proj-loader',
      teamId: team.teamId,
      type: 'local',
      title: 'loader-task',
      payload: { entrypoint: 'python3', argv: ['-c', 'print("loader ok")'] },
    }).task;
    const round = await service.runWorkerOnce();
    result.checks.taskStatus = round.task?.status ?? task.status;
    result.checks.taskError = round.task?.errorMessage ?? null;
    result.checks.teamCount = service.listTeams().length;
    result.checks.rsiAvailable = service.discoverRsi().available;
    result.ok = result.checks.serviceProvided === true
      && result.checks.initialized === true
      && result.checks.taskStatus === 'SUCCEEDED';
  } catch (error) {
    result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  writeFileSync(reportPath, JSON.stringify(result, null, 2));
}
