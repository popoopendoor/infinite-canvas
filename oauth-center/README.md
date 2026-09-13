# OAuth Center

![License](https://img.shields.io/badge/license-MIT-blue.svg) [![Latest Stable Version](https://img.shields.io/packagist/v/foskym/flarum-oauth-center.svg)](https://packagist.org/packages/foskym/flarum-oauth-center) [![Total Downloads](https://img.shields.io/packagist/dt/foskym/flarum-oauth-center.svg)](https://packagist.org/packages/foskym/flarum-oauth-center)

A [Flarum](http://flarum.org) extension. Allow user to authorize the third clients

## Canvas-maintained fork

This source is based on upstream `v1.3.0` and keeps its Composer package name,
Flarum extension ID, routes, and settings keys. It fixes both authorization
denial paths: form input only accepts explicit true values, and Fetch responses
always return OAuth's redirect location. A valid denial now returns the client
with `error=access_denied` and the original `state`.
Invalid Fetch requests without a safe OAuth redirect remain on the Flarum
authorization page with a retryable error instead of navigating to an undefined
path.

Install it as a Composer path repository before updating the package:

```json
{
  "repositories": [
    {
      "type": "path",
      "url": "/path/to/infinite-canvas/oauth-center",
      "options": {
        "symlink": false,
        "versions": { "foskym/flarum-oauth-center": "1.3.1" }
      }
    }
  ]
}
```

Then run `composer update foskym/flarum-oauth-center` in the Flarum installation
and keep the existing `foskym-oauth-center` extension enabled. Run
`php flarum cache:clear` after an update. No migration or OAuth client
recreation is required for this patch.

## Usage

- [中文文档](/docs/zh.md)
- [English Docs](/docs/en.md)

## Links

- [Upstream source](https://github.com/FoskyM/flarum-oauth-center)
- [Discuss](https://discuss.flarum.org/d/33413-oauth-center)
