import { orgPath, projectPath, type OrgRef, type ProjectRef } from '@/lib/authz';

import { ProjectGlyph, type Crumb } from './page-bar';

/**
 * The crumbs every page under a project or an organization starts with. Built
 * from the path helpers in `@/lib/authz`, so this module is server-only by
 * inheritance -- pages call it, client components never do.
 */

export function projectCrumb(org: OrgRef, project: ProjectRef): Crumb {
  return {
    label: project.name,
    href: projectPath(org, project),
    icon: <ProjectGlyph projectKey={project.key} />,
  };
}

export function orgCrumb(org: OrgRef): Crumb {
  return { label: org.name, href: orgPath(org) };
}
