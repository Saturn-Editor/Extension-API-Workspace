# API Workspace

An extension for Saturn that adds **API Workspace** projects: collections of HTTP requests, environments and encrypted secrets, all kept as plain files that work well with git.

Needs Saturn API 1.0.

## Using it

* On the Welcome screen, open **API Workspaces** and choose **New…**. The new workspace has an example request and a "Local" environment.
* The **API Workspace** panel lists requests by name with their method, grouped in folders, plus environments and secrets. Use its actions to add, rename, duplicate or delete requests, folders and environments. Deleted items go to `.local/trash`.
* Pick the method, environment or auth type from the menus in a request. The environment menu also has **New Environment…**.
* Open a `.apireq` file to edit and send a request. Press **Send** or Cmd/Ctrl+Enter.
* Pick the environment at the top of a request. Use `{{name}}` in the URL, params, headers, auth or body to insert a variable.
* To keep a token out of git, list its name under **Secrets** in an environment, then set its value with **Edit Secret Values…**. The workspace needs a password first: choose **Encrypt Project…** in action search.
* Requests can be found by name in action search.

Requests, environments and secrets also open in their own editors inside normal code projects.

### In a code project

The **API Requests** icon is in every code project's sidebar. Choose **Set Up** to add an API workspace to the project. It's stored in `.saturn/api/`, with the same files as below, so it's shared with your team through git like the rest of the project. Secrets use the project's password: choose **Encrypt Project…** in action search.

## Actions

* **API Workspace: New Request…**
* **API Workspace: New Environment…**
* **API Workspace: Import Postman, Bruno or OpenAPI…**
* **API Workspace: Switch Environment…**
* **API Workspace: Open Secrets**
* **API Workspace: Send Request**
* **API Workspace: Copy as curl**

## Importing

Choose **Import Postman, Bruno or OpenAPI…** in action search, then pick one or more files:

* **Postman:** a collection (v2.0 or v2.1) or an environment, exported as `.json`. Folders, query params, headers, bearer, basic and API key auth, raw, URL-encoded and GraphQL bodies, and collection variables come across. If the workspace is unlocked, Postman secret values are encrypted into Secrets.
* **Bruno:** pick `bruno.json` to import the whole collection with its folders and `environments`, or pick single `.bru` files. Secret names come across, but Bruno doesn't export their values.
* **OpenAPI:** OpenAPI 3 or Swagger 2, as JSON or YAML. Each operation becomes a request, grouped by its first tag. The body is filled from the examples, or built from the schema. You get an environment with `baseUrl` from the first server. Security turns into `{{token}}`, `{{apiKey}}` or `{{username}}` and `{{password}}` secrets.

Each import goes in its own folder under `requests/`, so nothing is overwritten. Anything that couldn't be brought across, like file uploads or OAuth 2 flows, is listed in a notice afterwards.

## Settings

* **Request timeout:** how long to wait for a response.
* **Follow redirects:** turn off to see 3xx responses as they are.

## Files

```
My API/
  api-workspace.json        marks the folder as an API workspace
  requests/                 one .apireq file per request; folders group them
    users/
      get-user.apireq
  environments/
    local.apienv            variables, and the names of secrets
  secrets.apisecret         secret values, each one encrypted
  .saturn/encryption.json   the workspace key, locked by the password
  .local/                   not committed: which environment is picked
  .gitignore
```

### api-workspace.json

```json
{ "name": "My API", "version": 1, "defaultEnvironment": "local" }
```

`defaultEnvironment` is the file name of an environment, without `.apienv`.

### .apireq

```json
{
  "name": "Get user",
  "method": "GET",
  "url": "{{baseUrl}}/users/{{userId}}",
  "query": [{ "name": "expand", "value": "teams", "enabled": true }],
  "headers": [{ "name": "Accept", "value": "application/json", "enabled": true }],
  "auth": { "type": "bearer", "token": "{{token}}" },
  "body": { "type": "none" }
}
```

* `auth.type` is `none`, `bearer` (with `token`) or `basic` (with `username` and `password`).
* `body.type` is `none`, `json` or `text` (with `text`), or `form` (with `form`, a list like `query`).

### .apienv

```json
{
  "name": "Local",
  "variables": [{ "name": "baseUrl", "value": "http://localhost:3000" }],
  "secrets": ["token"]
}
```

If a name is both a variable and a secret, the secret is used.

### secrets.apisecret

```json
{ "version": 1, "environments": { "local": { "token": "<encrypted>" } } }
```

Environments are keyed by file name. The secret names can be read in this file; only the values are encrypted. If the workspace is locked, requests that use a secret won't send until it's unlocked.

## Scripts

A request can have a **Before send** and an **After response** script, in the Scripts tab. Use `api.request`, `api.response`, `api.variables`, `api.test` and `api.expect`. Common Postman (`pm.*`) and Bruno (`bru`, `req`, `res`, `test`, `expect`) calls also work. Variables that scripts set last until Saturn restarts, or until you choose **Clear Script Variables**.

Scripts run in Saturn's sandbox, with no network, no file access and a 5-second limit. They never see secret values, and a request is refused if a script changes which server it goes to. If Saturn has no sandbox, scripts don't run.

## Known limits

* This is a proof of concept. It hasn't been run inside Saturn yet.
* Postman and Bruno scripts aren't imported yet.
* `pm.sendRequest` isn't supported.
* History is kept in `.local/history.json`, 30 entries per request, on this computer only.
* If you remove workspace encryption, secret values are written as plain text and `secrets.apisecret` is added to `.gitignore`.
