import app from 'flarum/forum/app';
import Alert from 'flarum/common/components/Alert';
import IndexPage from 'flarum/forum/components/IndexPage';
import LogInModal from 'flarum/forum/components/LogInModal';
import extractText from 'flarum/common/utils/extractText';
import Tooltip from 'flarum/common/components/Tooltip';
import Button from 'flarum/common/components/Button';
import LoadingIndicator from 'flarum/common/components/LoadingIndicator';
import Placeholder from 'flarum/common/components/Placeholder';
import avatar from 'flarum/common/helpers/avatar';

import ScopeComponent from '../ScopeComponent';

export default class AuthorizePage extends IndexPage {
  params = [];
  client = null;
  scopes = null;
  client_scope = [];
  loading = true;
  loadFailed = false;
  submit_loading = false;
  display_mode = 'box';

  oninit(vnode) {
    super.oninit(vnode);
    this.display_mode = app.forum.attribute('foskym-oauth-center.display_mode') || 'box';
    const params = m.route.param();

    if (params.client_id == null || params.response_type == null || params.redirect_uri == null) {
      m.route.set('/');
      return;
    }

    this.params = params;
    if (!app.session.user) {
      setTimeout(() => app.modal.show(LogInModal), 500);
      return;
    }

    this.loadAuthorizationData(params);
  }

  loadAuthorizationData(params) {
    this.loading = true;
    this.loadFailed = false;
    Promise.all([app.store.find('oauth-clients', params.client_id), app.store.find('oauth-scopes')])
      .then(([client, scopes]) => {
        if (!client) {
          this.loadFailed = true;
          this.loading = false;
          m.redraw();
          return;
        }

        this.client = client;
        this.scopes = scopes;

        let uris = this.client.redirect_uri().split(' ');

        if (app.forum.attribute('foskym-oauth-center.require_exact_redirect_uri') && !uris.includes(params.redirect_uri)) {
          this.loadFailed = true;
          this.loading = false;
          m.redraw();
          return;
        }

        if (!app.forum.attribute('foskym-oauth-center.allow_implicit') && params.response_type === 'token') {
          this.loadFailed = true;
          this.loading = false;
          m.redraw();
          return;
        }

        if (app.forum.attribute('foskym-oauth-center.enforce_state') && params.state == null) {
          this.loadFailed = true;
          this.loading = false;
          m.redraw();
          return;
        }

        let scopes_temp = params.scope ? params.scope.split(' ') : (this.client.scope() || '').split(' ');
        let default_scopes = this.scopes.filter((scope) => scope.is_default() === 1).map((scope) => scope.scope());

        this.client_scope = scopes_temp.filter((scope, index) => scopes_temp.indexOf(scope) === index);
        this.client_scope = this.client_scope.concat(default_scopes).filter((scope) => scope !== '');

        this.loading = false;
        m.redraw();
      })
      .catch(() => {
        this.loadFailed = true;
        this.loading = false;
        m.redraw();
      });
  }

  setTitle() {
    app.setTitle(extractText(app.translator.trans('foskym-oauth-center.forum.page.title.authorize')));
    app.setTitleCount(0);
  }

  view() {
    if (this.loadFailed) {
      return <Placeholder text={app.translator.trans('foskym-oauth-center.forum.authorize.request_failed')} />;
    }
    if (!this.client || this.loading) {
      return <LoadingIndicator />;
    }
    return (
      <div className="AuthorizePage">
        <div className="container">
          <div class="oauth-area">
            <div class={'oauth-main oauth-' + this.display_mode}>
              <div class="oauth-header">
                <h2>{app.forum.attribute('title')}</h2>
                <p>
                  {app.translator.trans('foskym-oauth-center.forum.authorize.access')}{' '}
                  <Tooltip text={this.client.client_desc()} position="bottom">
                    <a href={this.client.client_home()} target="_blank">
                      {this.client.client_name()}
                    </a>
                  </Tooltip>
                </p>
              </div>
              <div class="oauth-body">
                <div class="oauth-user">
                  {avatar(app.session.user, { className: 'oauth-avatar' })}
                  <div class="oauth-username">
                    <b>{app.session.user.username()}</b>
                    <span>{app.session.user.displayName()}</span>
                  </div>
                </div>

                <div class="oauth-info">
                  <Tooltip text={app.forum.attribute('title')}>
                    <img src={app.forum.attribute('faviconUrl')} alt="favicon" />
                  </Tooltip>
                  <i class="fas fa-exchange-alt fa-2x"></i>
                  <Tooltip text={this.client.client_desc()}>
                    <img src={this.client.client_icon()} alt="client_icon" />
                  </Tooltip>
                  <span>{this.client.client_name()}</span>
                </div>
                <div class="oauth-scope-area">
                  <h3>{app.translator.trans('foskym-oauth-center.forum.authorize.require_these_scopes')}</h3>
                  {this.client_scope
                    .filter((scope) => scope)
                    .map((scope) => {
                      let scope_info = this.scopes.find((s) => s.scope() === scope);
                      return scope_info && <ScopeComponent scope={scope_info} client={this.client} />;
                    })}
                </div>
                <form class="oauth-form" method="post" id="form" action="/oauth/authorize" onsubmit={this.onsubmit.bind(this)}>
                  {Object.keys(this.params).map((key) => (
                    <input type="hidden" name={key} value={this.params[key]} />
                  ))}
                  <div class="oauth-form-item oauth-btn-group">
                    <Button className="Button" type="submit" name="is_authorized" value="false" style="width: 50%;" loading={this.submit_loading}>
                      {app.translator.trans('foskym-oauth-center.forum.authorize.deny')}
                    </Button>
                    <Button
                      className="Button Button--primary"
                      type="submit"
                      name="is_authorized"
                      value="true"
                      style="width: 50%;"
                      loading={this.submit_loading}
                    >
                      {app.translator.trans('foskym-oauth-center.forum.authorize.agree')}
                    </Button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  onsubmit(e) {
    if (!app.forum.attribute('foskym-oauth-center.authorization_method_fetch')) {
      return;
    }

    e.preventDefault();
    this.submit_loading = true;
    app
      .request({
        method: 'POST',
        url: '/oauth/authorize/fetch',
        body: {
          ...this.params,
          is_authorized: e.submitter.value === 'true',
        },
      })
      .then((params) => {
        if (params && typeof params.location === 'string' && params.location) {
          window.location.assign(params.location);
          return;
        }

        this.authorizationFailed();
      })
      .catch(() => {
        this.authorizationFailed();
      });
  }

  authorizationFailed() {
    this.submit_loading = false;
    app.alerts.show(Alert, { type: 'error' }, app.translator.trans('foskym-oauth-center.forum.authorize.request_failed'));
    m.redraw();
  }
}
